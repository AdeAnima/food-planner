# groceries-mcp Design Spec

**Sub-project 2 of 3** in the offers rewrite (offers-core → groceries-mcp → /weekplan rewire).

**Goal:** An MCP server that exposes German-supermarket offer + store-location
data to Claude, importing `offers-core` as a git dependency. Thin plumbing
layer: all business logic lives in offers-core; the MCP only wraps it as tools.

**Status of siblings:**
- offers-core (sub-project 1) — complete, merged to `main` (`50ac0f9e`). Standalone lib + thin HTTP server.
- /weekplan rewire (sub-project 3) — separate spec/plan, NOT covered here.

---

## Architecture

Three layers, two repos:

```
offers-core repo (extracted to github.com/AdeAnima/offers-core)   ← Phase A
  lib: getOffers, getOfferDetails, syncOne, openDb
  + NEW location layer: geocode, listStores, resolveNearest
  thin HTTP server (existing) + new /geocode and extended /stores
        ↓ git+ssh dependency, pinned tag (v0.x.0)
groceries-mcp (mcp-servers/groceries-mcp)                         ← Phase B
  imports offers-core lib in-process, shares the SQLite file
  exposes MCP tools (thin zod wrappers, no business logic)
        ↓ MCP protocol
/weekplan skill                                                   ← Phase C (sub-project 3)
```

**Why import the lib in-process (not HTTP client to :3000):** personal/local
use, one process, no second server to keep alive, shares the SQLite file
directly. Decided in brainstorming.

**Why offers-core owns the location layer (not the MCP):** store-location
resolution is data the offers system owns, same as offers themselves. The MCP
stays thin. The geocoding machinery that currently lives in
`supermarkets-mcp/src/geocode.ts` moves DOWN into offers-core.

---

## Global Constraints

- **Runtime:** bun + TypeScript only. Zero third-party runtime deps beyond what
  each layer already declares (offers-core: node builtins + `bun:sqlite`;
  groceries-mcp: `@modelcontextprotocol/sdk` + `zod`, matching the existing
  cookidoo-mcp / supermarkets-mcp pattern).
- **offers-core dependency:** consumed via `git+ssh://git@github.com:AdeAnima/offers-core.git#<tag>`,
  pinned to a released tag — never a floating branch.
- **Price contract (inherited, frozen):** every price is integer cents OR null.
  Never coerce missing/0/negative/NaN/Infinity → 0. A `0` in the price column is a bug.
- **Append-only:** offers table stays append-only (`ON CONFLICT DO NOTHING`).
  No new mutable-offer paths.
- **No live network in tests:** Nominatim / Overpass / retailer APIs are stubbed.
  bun:test, `openDb(":memory:")` for DB-touching tests.
- **No Claude co-author / "Generated with" lines in commits.**
- **Worktree isolation** for all writing tasks.

---

## Phase A — offers-core location layer

Added to offers-core **before** it is extracted to its own repo, so the
extracted `v0.x.0` tag already contains the location capability groceries-mcp
needs.

### A1. Geocoding (moved down from supermarkets-mcp)

Move `geocodeAddress`, `isGermanZip`, `resolveZipFromInput` from
`mcp-servers/supermarkets-mcp/src/geocode.ts` into
`offers-core/src/core/geocode.ts`. Port verbatim where possible (it is already
bun+TS, OSM Nominatim, file-cached 30d). Adapt the cache path to offers-core's
`data/` convention.

- **Primary input is real lat/lon.** Address/zip is a *fallback* that geocodes
  to lat/lon first.
- **Bare zip → centroid only.** When the caller supplies only a zip (no street),
  the geocode returns the postcode centroid and the result carries
  `approximate: true`. Accurate walking/travel distance needs real coordinates;
  the flag tells downstream "this distance is rough."

Interface:
```ts
export function isGermanZip(input: string): boolean;
export interface GeocodeResult { lat: number; lon: number; zip: string; approximate: boolean; }
export async function geocodeAddress(address: string): Promise<GeocodeResult | { error: string; candidates?: string[] }>;
```
Ambiguous / not-found address → `{ error, candidates? }`. Never silently pick a wrong location.

### A2. Store listing + nearest resolution

offers-core already has `haversineKm` and `nearestStore(stores, lat, lon)` in
`src/core/stores.ts`, a `stores` table, and per-retailer `stores()` fetchers
(`lidlStores`, `edekaMarkets`). Add two DB-query functions:

```ts
export interface StoreFilter { retailer?: string; region?: string; scope?: Scope; }
export function listStores(db: Database, filter: StoreFilter): Store[];

export interface ResolvedStore extends Store { distKm: number; }
// nearest N stores of a retailer to a point, ascending distance
export function resolveNearest(
  db: Database, retailer: string, lat: number, lon: number, limit?: number,
): ResolvedStore[];
```

`resolveNearest` is a **pure lookup**: it returns stores + their key
(`storeId` / `region` / `gln` per the existing `Store` shape) + haversine
distance. It NEVER triggers an offer fetch. Getting offers is a separate
explicit call (see Phase B `fetch_offers`).

**Store-table population:** `listStores` / `resolveNearest` read whatever is in
the `stores` table. Populating it from the per-retailer `stores()` fetchers
(currently lidl, edeka) reuses the existing `upsert`-style path; retailers
without a `stores()` fetcher simply return no rows for that retailer (callers
handle empty, same as today).

### A3. Server endpoints

Extend the existing thin server:

- `GET /geocode?q=<address-or-zip>` → `GeocodeResult` or `{ error, candidates? }`.
- `GET /stores?retailer=&region=&scope=&lat=&lon=&limit=` →
  - with `lat`+`lon`: `ResolvedStore[]` (nearest, sorted by `distKm`)
  - without coords: `listStores` filtered result
  - (replaces today's lidl-only geo `/stores` with the general version)

### A4. Extract offers-core to its own repo

1. Create `github.com/AdeAnima/offers-core`.
2. Move the `offers-core/` subtree there **preserving git history**
   (`git subtree split` or `git filter-repo` on the path), push.
3. Tag a release (`v0.x.0`) containing the A1–A3 location layer.
4. In the food-planner repo, the `offers-core/` folder is removed and instead
   consumed as a dependency by groceries-mcp (Phase B). (The folder's history
   now lives in the new repo; the merged `main` commit remains as provenance.)

> Tag version: pick the next after offers-core's current internal version
> (it was at `v0.1.x` range per the cookidoo-split memory; the plan picks the
> concrete number at execution from `offers-core/package.json`).

---

## Phase B — groceries-mcp

Location: `mcp-servers/groceries-mcp/`. Mirrors the existing
cookidoo-mcp / supermarkets-mcp layout (`src/index.ts`, package.json with
`@modelcontextprotocol/sdk` + `zod`, `start`/`dev`/`typecheck`/`test` scripts).

### package.json dependency

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0",
  "zod": "^3.23.8",
  "offers-core": "git+ssh://git@github.com:AdeAnima/offers-core.git#v0.x.0"
}
```

### Tools (thin zod wrappers over offers-core)

| MCP tool | offers-core call | Notes |
|----------|------------------|-------|
| `geocode(address)` | `geocodeAddress` | address/zip → lat/lon/zip/approximate. Returns `error`+`candidates` on miss. |
| `find_stores(lat, lon, retailer?, limit?)` | `resolveNearest` / `listStores` | pure lookup; returns stores + key + `distKm`. No fetch. |
| `fetch_offers(retailer, key)` | `syncOne` | explicit fetch of that store's current offers into the DB. Keyed retailers require `key`; kaufland ignores it (national). |
| `search_offers(terms?, retailer?, foodOnly?, priceMin?, priceMax?, validOn?, …)` | `getOffers` | reads slim offers from DB. |
| `get_offer(retailer, key, offerId, validFrom, groups?)` | `getOfferDetails` | full composite key; `groups` selects info groups. |

The MCP holds **no business logic** — zod schemas + a one-line call into
offers-core per tool. DB opened once (`openDb()`), shared across handlers.

### The /weekplan data flow this enables

```
geocode(address)                 → lat/lon
  → find_stores(lat,lon,retailer) → [{key, distKm}]
  → fetch_offers(retailer, key)   → syncOne writes to SQLite (append-only)
  → search_offers(terms, …)       → slim offer list
```
Kaufland skips geocode/find_stores (national, no key) — call `fetch_offers("kaufland")` then `search_offers`.

---

## Error handling

- **geocode miss / ambiguous:** `{ error, candidates? }`. Never a silent wrong pick.
- **bare zip:** centroid lat/lon, `approximate: true`. Downstream distance is rough; flag surfaced.
- **keyed retailer fetch without key:** reject loudly (offers-core already returns `"needs key resolution"`).
- **retailer API down:** per-retailer error; other retailers still return (degraded, not total failure). Mirrors offers-core's existing per-retailer isolation.
- **price contract:** integer cents or null, never 0-coerce (inherited, unchanged).

---

## Testing

- **offers-core location layer (Phase A):**
  - `geocode`: stubbed Nominatim — hit, miss (`{error}`), ambiguous (`candidates`), bare-zip → `approximate:true`, cache hit/miss. No live network.
  - `listStores` / `resolveNearest`: seed `stores` table in `openDb(":memory:")`; assert filter results and exact haversine-sorted `distKm`.
  - server endpoints: `makeApp(seedDb)` request tests for `/geocode`, `/stores` (with + without coords).
- **groceries-mcp (Phase B):**
  - tool-handler tests with in-memory DB; stub offers-core where it would hit the network (`fetch_offers`).
  - assert each tool's zod input/output schema and error shapes (geocode miss, missing key).
  - bun:test, zero live network in CI.

---

## Out of scope (YAGNI / deferred)

- **Walking/travel-distance optimization & trip planning** — haversine straight-line
  distance only for now; multi-stop trip optimization is offers-core `FUTURE.md`.
- **Cron-warmed sync** — fetch is on-demand via the `fetch_offers` tool only. No scheduled sync in this sub-project.
- **HTTP-client mode** — in-process lib import only; no `OFFERS_CORE_URL` switch.
- **Dietary tag system** — offers-core `FUTURE.md` v2, not here.
- **/weekplan rewire & supermarkets-mcp deletion** — sub-project 3, separate spec.

---

## Build order summary

1. **Phase A** — offers-core: geocode-move-down + listStores + resolveNearest + endpoints, then extract to own repo + tag.
2. **Phase B** — groceries-mcp: scaffold, git-dep on offers-core, 5 thin tools, tests.
3. **Phase C** *(sub-project 3, separate)* — rewire /weekplan, delete supermarkets-mcp.
