# offers-core — Design Spec

**Date:** 2026-06-26
**Status:** Approved (brainstorming), ready for implementation plan
**Sub-project:** 1 of 3 — see *Decomposition* below

---

## North star

This is **infrastructure for the food-planner precise-location / walking-distance meal-planning feature**, not an end in itself. Every decision here serves that downstream consumer. The original feature: plan a week of dinners optimized against supermarket offers reachable on foot from the user's location.

## Decomposition

Three independent sub-projects, each with its own spec → plan → implementation cycle:

1. **offers-core** (this spec) — bun/TS library + thin HTTP server. Fetches German supermarket offers, normalizes, persists, serves slim responses + detail endpoint + generic filters.
2. **offers-mcp** (own spec) — MCP server wrapping offers-core. Filters param-activatable at MCP level.
3. **food-planner-rewire** (own spec) — drop bundled `supermarkets-mcp`, point `/weekplan` at offers-mcp.

Both new repos are **private/personal first**. Publishing decided later as its own call.

---

## 1. Scope & sequencing

### What offers-core IS
A bun/TS **library** (pure functions + per-retailer clients) plus a **thin HTTP server** (`Bun.serve`, no framework) that:
- fetches offers from ~5 German retailers,
- normalizes to one slim `Offer` shape (token-saving for the LLM consumer),
- **persists everything in a bun:sqlite DB** (history retained, append-only),
- exposes **generic** param-activated filters,
- exposes a **detail endpoint** for on-demand full fields,
- exposes a **store-locator** (coords → nearest store/region/GLN).

### What it is NOT (YAGNI for v1)
- No diet logic — stays in the LLM consumer (food-planner).
- No tag system — designed-for, schema reserved, **zero code**.
- No per-store offer plumbing for regional/national chains (only Edeka is true per-store).
- No REWE — deferred/experimental.
- No internal scheduler — OS cron / manual trigger.

### Build sequence — vertical slice, NOT horizontal fan-out
1. **Slice 1 — Lidl** (zero auth, fastest green): client → normalize → slim → DB → generic filters → detail → server. Proves *plumbing* + measures token savings.
2. **Slice 2 — Edeka** (only true per-store, OAuth lifecycle, zip→GLN): **co-defines the contract**. Types are frozen only after Edeka lands — Lidl alone cannot exercise store-scope availability, OAuth token lifecycle, or zip→GLN lookup.
3. **Then** remaining clients (Penny, Kaufland, Marktguru) against the proven contract.
4. **REWE deferred** — mTLS path never run live; v1 falls back to Marktguru zip-level.

---

## 2. Retailer landscape (reverse-engineered)

All verified live except REWE. Secrets are **already public in OSS**; they rotate → stored in env/config with documented re-extraction path, **never hardcoded in source**.

| Retailer | Scope | Auth | Path |
|----------|-------|------|------|
| **Lidl** | region | none | store autocomplete (lat/lon) → `storeKey` → offers. `Accept-Language: de-DE` mandatory. |
| **Edeka** | **store** (true per-Filiale) | OAuth2 client_credentials (public app creds, ~360s token) | markets-by-zip → GLN → offers. Host `b2c-gw.api.edeka` (NOT www — Akamai 403). |
| **Penny** | region (44 sellingRegions) | none | full market list (~2117) → PLZ → sellingRegion → offers-by-category. |
| **Kaufland** | **national** (store picker cosmetic) | none | SSR JSON blob scraped from HTML via regex. |
| **Marktguru** | zip-level | homepage key-harvest | Aldi N/Süd + zip fallback. Port existing code. |
| **REWE** | market | mTLS cert (APK-extracted) | DEFERRED. v1 falls back to Marktguru. Not live-verified. |

### Recipes (verbatim, for implementation)
- **Edeka:** `POST https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token`, header `Authorization: Basic base64("edeka-app-android-client:wFoBG7VhAIn48kx9SDyVhaN9FttvPZi2")`, body `grant_type=client_credentials` → token (~360s). `GET https://b2c-gw.api.edeka/v3/markets?zipCode={zip}&size=20&page=0` Bearer → `markets[].gln`. `GET https://b2c-gw.api.edeka/v2/offers/mobile?marketGln={gln}&size=200&page=0&sortedByCategory=true` Bearer → `{totalCount, validFrom, validTill, offers[]}`.
- **Lidl:** `GET https://stores.lidlplus.com/api/v1/autocomplete/DE?input={city}&language=de&latitude={lat}&longitude={lon}` → `[0].storeKey`. `GET https://offers.lidlplus.com/app/api/v4/DE/{storeKey}/offers` header `Accept-Language: de-DE` → `{offers[], totalOffers}`.
- **Penny:** `GET https://www.penny.de/.rest/market` (cache) filter `zipCode` → `sellingRegion`. `GET https://www.penny.de/.rest/offers/by-category/{year}-{isoWeek}/{category}?region={sellingRegion}` → `{offerTiles[]}` (filter `primaryType==="offer"`).
- **Kaufland:** `GET https://filiale.kaufland.de/angebote/uebersicht.html?kloffer-category=0001_TopArticle&kloffer-week=current` browser UA → regex `window\.SSR\['[^']+'\] = (\{.*?\});?\s*</script>` → `JSON.parse` → `props.offerData.cycles[].categories[].offers[]`.
- **REWE (deferred):** `mobile-api.rewe.de/api/stationary-markets/search?search={PLZ}` → `marketId`; `mobile-api.rewe.de/api/stationary-offers/{marketId}`. Both mTLS (cert `/res/raw/mtls_prod.pfx`, pw `NC3hDTstMX9waPPV`). Bun: `fetch(url, { tls: { cert, key } })`.

---

## 3. Module layout

```
offers-core/
  data/offers.db            # bun:sqlite, gitignored
  src/
    retailers/
      lidl.ts               # fetch raw → RawOffer[] + store lookup. No filter/slim.
      edeka.ts              # OAuth + per-store
      penny.ts              # sellingRegion resolve
      kaufland.ts           # national SSR scrape
      marktguru.ts          # Aldi N/Süd + zip fallback (port existing)
      rewe.ts               # stub, mTLS, deferred
    core/
      types.ts              # Offer, RawOffer, Store, InfoGroup, Scope
      normalize.ts          # RawOffer → slim Offer per retailer; stash raw for detail
      filter.ts             # generic param filters → SQL WHERE
      stores.ts             # coords → nearest store/region/GLN (locator)
      db.ts                 # bun:sqlite: schema, migrations (PRAGMA user_version), upsert, queries
      sync.ts               # syncRetailer orchestration + post-sync sanity check
    index.ts                # library public API ({lidl, edeka, ...} literal — no registry file)
    server.ts               # thin Bun.serve route switch, ~50 lines
  FUTURE.md                 # deferred features (see §8)
```

**Boundaries:**
- Each `retailers/*.ts`: one job — talk to that retailer, return `RawOffer[]` + store lookup. No filtering, no slimming. Fixture-testable in isolation.
- `normalize.ts`: maps each retailer's raw → slim `Offer`; stores full raw JSON in DB (feeds detail endpoint, no upstream re-fetch).
- No `registry.ts` — 5 static retailers = a plain object literal in `index.ts`.
- `server.ts`: parses query params → calls library → returns JSON. No framework (`Bun.serve` + manual route switch).
- **Store-locator first-class**: `stores.ts` resolves coords → nearest store/region/GLN. Only Edeka attaches offers per-store; regional chains attach at region; Kaufland national. The locator is what makes walking-distance work — but only `scope=store` results are genuinely walkable (see §5).

---

## 4. Persistence — bun:sqlite, permanent + append-only

**Decision:** persistent DB, not a TTL cache. Offers stored permanently, history retained. Cold start = read DB, not re-fetch. "Cache invalidation" replaced by sync cadence. `bun:sqlite` is built-in → zero dep. Generic filters become SQL WHERE. Detail endpoint reads `offers.raw` directly.

### Schema
```sql
stores (
  id INTEGER PRIMARY KEY,
  retailer TEXT, storeId TEXT, name TEXT, zip TEXT,
  lat REAL, lon REAL, region TEXT, gln TEXT, scope TEXT,
  fetchedAt TEXT,
  UNIQUE(retailer, storeId)
)

offers (
  id INTEGER PRIMARY KEY,                 -- surrogate PK
  offerId TEXT,                            -- retailer's own id (NOT unique alone)
  retailer TEXT,
  scope TEXT,                              -- 'store' | 'region' | 'national'
  storeOrRegionKey TEXT,                   -- GLN / region / 'national'
  title TEXT,
  category TEXT,                           -- slim column (filterable)
  price INTEGER,                           -- cents, integer
  quantity TEXT,                           -- slim column (price-per-unit math)
  unit TEXT,
  validFrom TEXT, validTo TEXT,
  weekKey TEXT,                            -- ISO week, e.g. 2026-W27 (history queries)
  raw TEXT,                                -- full upstream object, JSON
  fetchedAt TEXT,
  UNIQUE(retailer, storeOrRegionKey, offerId, validFrom)
)

-- v2 RESERVED, NOT created in v1:
-- offer_tags (offerId, tag, vocabVersion, enrichedAt)
```

**PK rationale (Blocker 1 fix):** surrogate `id` PK + UNIQUE on `(retailer, storeOrRegionKey, offerId, validFrom)`. `offerId` alone is NOT unique — retailers reuse it across weeks (recurring flyer items) and across regions. Keying on `validFrom` (offer-intrinsic) not `weekKey` (fetch-cadence artifact) keeps history correct: a recurring offer with a new validity window is a distinct row; a re-fetch of the same window is a dedup'd upsert.

### Migrations (Minor 5 fix)
`PRAGMA user_version`. On open: if `< CURRENT`, run ordered `ALTER TABLE` steps, bump version. In-file, no framework. **Additive-only** — new column = NULL on old rows; append-only history tolerates this. No destructive migrations planned.

### Sync model
- `syncRetailer(r, kind)` → fetch → upsert (UNIQUE conflict on exact window = dedup/skip; new window = append).
- **No internal scheduler** (YAGNI). Triggered by `POST /sync` or CLI (`bun run sync`). OS cron is the user's choice, outside the lib.
- **Two cadences:** `stores` rarely (manual/monthly), `offers` weekly per region.
- **Post-sync sanity check (Major 4 fix):** row count per `(retailer, region)` vs prior week; ratio outside `[0.3, 3]` → `anomaly` flag in sync response. Catches silent scraper-zero (Kaufland redesign, Edeka cred rotation) which otherwise looks like an empty flyer. The history table is the monitor.

---

## 5. Data shapes

### Slim `Offer` (default list rows — token-saving)
```ts
type Scope = "store" | "region" | "national"

type Offer = {
  offerId: string          // retailer's id (PK is surrogate + composite UNIQUE)
  retailer: string         // "lidl" | "edeka" | ...
  scope: Scope             // disambiguates walkability (Blocker 3 fix)
  storeOrRegionKey: string // GLN / region / "national"
  title: string
  category: string         // slim (filterable — Blocker 2 fix)
  price: number            // cents, integer
  quantity?: string        // slim (price-per-unit math — Blocker 2 fix)
  unit?: string
  validFrom: string        // ISO date
  validTo: string          // ISO date
}
```
Everything else (images, full descriptions, category trees, brand, raw upstream) lives in `offers.raw` JSON — fetched only via the detail endpoint.

**`scope` (Blocker 3 fix):** the walking-distance premise only holds for `scope=store` (Edeka GLN). For `region`/`national`, "nearest store" resolves to a region or is cosmetic — the consumer MUST distinguish, or it computes walking distance to things with no location.

### Info-groups (detail endpoint projections over `raw`)
- `pricing` — basePrice detail, discount %, was-price, deposit
- `classification` — category path, brand, upstream dietary hints
- `media` — image URLs, flyer page
- `raw` — whole upstream object untouched
- `all` — every group

### Detail endpoint
```ts
getOfferDetails(offerId, groups[]) → { offerId, pricing?, classification?, media?, raw? }
```
Reads `offers.raw` from DB, projects requested groups. No upstream call.

---

## 6. Filters (v1 generic, param-activated)

All optional, AND-combined → SQL WHERE. **Diet logic NOT here** — stays in the LLM consumer.

| Param | Type | WHERE |
|-------|------|-------|
| `retailers` | csv | `retailer IN (...)` |
| `scope` | `store\|region\|national` | `scope = ?` |
| `storeOrRegionKey` | string | `storeOrRegionKey = ?` (resolved from coords by locator) |
| `category` | csv | `category IN (...)` |
| `priceMax` / `priceMin` | int cents | `price <= ? / >= ?` |
| `validOn` | ISO date | `validFrom <= ? AND validTo >= ?` (default today) |
| `weekKey` | ISO week | `weekKey = ?` (history queries) |
| `foodOnly` | bool | `category` not in non-food set |
| `q` | string | `title LIKE ?` |

`foodOnly` = the one coarse food/non-food cut, deterministic, cheap.

---

## 7. Server endpoints

Thin `Bun.serve` route switch, no framework:
```
GET  /offers?<filters>             → slim Offer[]
GET  /offers/:offerId?groups=...   → detail (projects raw)
GET  /stores?lat=&lon=&retailers=  → nearest store/region per retailer (locator)
POST /sync?retailers=&kind=        → trigger sync (offers|stores); returns {counts, anomalies[]}
```

---

## 8. v2 hook & future features (design-for, build nothing)

### v2 tag system (Major 7 fix)
Tags are **mutable** + **vocabulary-versioned**; `offers` is **immutable append-only**. Incompatible on one table. So v1 adds **NO** `tags` column — not even a stub. A separate `offer_tags(offerId, tag, vocabVersion, enrichedAt)` table is **reserved, not created**. v2: server owns tag vocabulary + filter defs; an enrich endpoint lets a Haiku-agent-per-store write tags for offers lacking them; filters JOIN and return offers NOT carrying given tags. v1 ships zero tag code; the schema just stays uncorrupted.

### FUTURE.md (write at scaffold)
> **Cross-store best-price + trip optimization.** Compare an item's price across all retailers/stores to find the genuine best price for each item. Optimize the shopping trip for least walking/travel time, with definable trip constraints (max stops, transport mode, max detour, etc.). Builds on the persistent multi-retailer offer DB + the store-locator. Future — not v1.

---

## 9. Testing

ponytail: one runnable check per non-trivial logic path, `bun:test`, no fixtures-heavy framework.
- Each `retailers/*.ts`: normalize a captured fixture → assert slim `Offer` shape.
- `db.ts`: assert composite-UNIQUE keeps history (insert same `offerId` two `validFrom`s → 2 rows; same window twice → 1 row).
- `filter.ts`: param set → expected WHERE / result subset.
- `sync.ts`: post-sync anomaly ratio triggers flag.

---

## Open decisions (folded into review, none blocking)
- **Publishing** offers-core/offers-mcp: deferred. Private first.
- **REWE**: deferred/experimental until mTLS run live.
