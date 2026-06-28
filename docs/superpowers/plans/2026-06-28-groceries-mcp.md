# groceries-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `groceries-mcp`, a thin MCP server exposing German-supermarket offer + store-location data to Claude, importing `offers-core` as a git dependency.

**Architecture:** Phase A adds a location layer to `offers-core` (geocode moved down from `supermarkets-mcp`, plus `listStores`/`resolveNearest`/new endpoints), then extracts offers-core to its own repo and tags a release. Phase B builds `groceries-mcp` in `mcp-servers/groceries-mcp/`, importing offers-core via git+ssh dep, exposing 5 thin zod-wrapped tools that call offers-core in-process and share its SQLite file.

**Tech Stack:** bun + TypeScript, `bun:sqlite`, `@modelcontextprotocol/sdk` ^1.29.0, `zod` ^3.23.8, OSM Nominatim (geocode) + Overpass (stores). bun:test.

**Spec:** `docs/superpowers/specs/2026-06-28-groceries-mcp-design.md`

## Global Constraints

- bun + TypeScript only. offers-core runtime deps: node builtins + `bun:sqlite` only (zero third-party). groceries-mcp deps: `@modelcontextprotocol/sdk` ^1.29.0 + `zod` ^3.23.8 only.
- offers-core consumed via `git+ssh://git@github.com:AdeAnima/offers-core.git#<tag>`, pinned to a released tag — never a floating branch.
- Price contract (frozen): price is integer cents OR null. Never coerce missing/0/negative/NaN/Infinity → 0.
- offers table append-only (`ON CONFLICT DO NOTHING`). No new mutable-offer paths.
- No live network in tests: Nominatim / Overpass / retailer APIs stubbed. Use `openDb(":memory:")` for DB tests.
- No Claude co-author / "Generated with" lines in commits.
- `WEEKPLAN_CONTACT` env var is required at runtime for any Nominatim/Overpass call (their usage policy requires operator contact in the User-Agent). Tests must not depend on it (network stubbed).
- All store-locating distance is straight-line haversine. Walking/travel-distance optimization is OUT of scope.

---

## File Structure

**Phase A — offers-core (`offers-core/`):**
- Create `src/core/geocode.ts` — geocoding (Nominatim) + `isGermanZip`, ported from supermarkets-mcp, return shape adapted to spec.
- Modify `src/core/db.ts` — add `listStores(db, filter)` query.
- Create `src/core/locate.ts` — `resolveNearest(db, retailer, lat, lon, limit)` + `storeKey(store)` helper.
- Modify `src/server.ts` — add `GET /geocode`, replace lidl-only `/stores` with the general filter+nearest version.
- Modify `package.json` — flip `private`, bump version for the release tag.
- Tests: `test/geocode.test.ts`, `test/locate.test.ts`, extend `test/server.test.ts`.

**Phase B — groceries-mcp (`mcp-servers/groceries-mcp/`):**
- Create `package.json`, `tsconfig.json`, `src/index.ts` (server + 5 tools), `src/handlers.ts` (the offers-core calls, testable without MCP transport).
- Tests: `test/handlers.test.ts`.

---

## Phase A — offers-core location layer

### Task 1: Geocoding module (port + adapt return shape)

Port the Nominatim geocoder from `mcp-servers/supermarkets-mcp/src/geocode.ts` into offers-core, adapting the return contract to the spec: a discriminated result (`GeocodeResult | { error, candidates? }`), field `zip` (not `zipCode`), and an `approximate` flag. Keep the 30-day file cache and the `WEEKPLAN_CONTACT` User-Agent requirement.

**Files:**
- Create: `offers-core/src/core/geocode.ts`
- Test: `offers-core/test/geocode.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export function isGermanZip(input: string): boolean;
  export interface GeocodeOk { lat: number; lon: number; zip: string; approximate: boolean; displayName: string; }
  export interface GeocodeErr { error: string; candidates?: string[]; }
  export type GeocodeResult = GeocodeOk | GeocodeErr;
  export async function geocode(query: string): Promise<GeocodeResult>;
  ```
  `geocode` accepts a free-text address OR a bare 5-digit zip. A bare zip resolves to the postcode centroid with `approximate: true`. A street address resolves with `approximate: false`. Not-found → `{ error }`. Multiple plausible matches → `{ error, candidates }`.

- [ ] **Step 1: Write the failing test**

```ts
// offers-core/test/geocode.test.ts
import { test, expect, mock, afterEach } from "bun:test";
import { isGermanZip } from "../src/core/geocode.ts";

test("isGermanZip: 5 digits true, else false", () => {
  expect(isGermanZip("80331")).toBe(true);
  expect(isGermanZip(" 80331 ")).toBe(true);
  expect(isGermanZip("8033")).toBe(false);
  expect(isGermanZip("munich")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offers-core && bun test test/geocode.test.ts`
Expected: FAIL — `Cannot find module "../src/core/geocode.ts"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// offers-core/src/core/geocode.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const CACHE_DIR = join(homedir(), ".offers-core");
const GEOCODE_CACHE = join(CACHE_DIR, "geocode.json");
const FETCH_TIMEOUT_MS = 15000;

export function isGermanZip(input: string): boolean {
  return /^\d{5}$/.test(input.trim());
}

export interface GeocodeOk { lat: number; lon: number; zip: string; approximate: boolean; displayName: string; }
export interface GeocodeErr { error: string; candidates?: string[]; }
export type GeocodeResult = GeocodeOk | GeocodeErr;

interface CacheEntry extends GeocodeOk { cachedAt: number; }

function getUserAgent(): string {
  const contact = process.env.WEEKPLAN_CONTACT?.trim();
  if (!contact) {
    throw new Error(
      "offers-core geocode: WEEKPLAN_CONTACT env var is required (your email or URL). " +
      "Nominatim usage policy requires operator contact info in the User-Agent.",
    );
  }
  return `offers-core/0.1 (contact: ${contact})`;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o644 });
  await rename(tmp, path);
}

async function readCache(): Promise<Record<string, CacheEntry>> {
  try { return JSON.parse(await readFile(GEOCODE_CACHE, "utf8")) as Record<string, CacheEntry>; }
  catch { return {}; }
}

export async function geocode(query: string): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { error: "geocode: query is required" };
  const approximate = isGermanZip(q);

  const cacheKey = q.toLowerCase();
  const cache = await readCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.cachedAt < 30 * 24 * 3600 * 1000) {
    const { cachedAt, ...rest } = hit;
    return rest;
  }

  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "de");
  url.searchParams.set("limit", "5");

  const r = await fetchWithTimeout(url, {
    headers: { "User-Agent": getUserAgent(), "Accept-Language": "de-DE,de;q=0.9" },
  });
  if (!r.ok) return { error: `Nominatim geocode failed: ${r.status}` };

  const results = (await r.json()) as Array<{
    lat: string; lon: string; display_name: string;
    address?: { postcode?: string };
  }>;
  if (results.length === 0) return { error: `no result for "${q}"` };

  const top = results[0]!;
  const zip = top.address?.postcode ?? "";
  if (!isGermanZip(zip)) {
    return { error: `result has no German postcode for "${q}"`, candidates: results.map((x) => x.display_name) };
  }

  const out: GeocodeOk = {
    lat: parseFloat(top.lat), lon: parseFloat(top.lon), zip, approximate, displayName: top.display_name,
  };
  cache[cacheKey] = { ...out, cachedAt: Date.now() };
  await atomicWriteJson(GEOCODE_CACHE, cache);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offers-core && bun test test/geocode.test.ts`
Expected: PASS (the `isGermanZip` test; no network touched).

- [ ] **Step 5: Add a network-stubbed geocode test**

```ts
// append to offers-core/test/geocode.test.ts
import { geocode } from "../src/core/geocode.ts";

const origFetch = globalThis.fetch;
const origContact = process.env.WEEKPLAN_CONTACT;
afterEach(() => { globalThis.fetch = origFetch; if (origContact === undefined) delete process.env.WEEKPLAN_CONTACT; else process.env.WEEKPLAN_CONTACT = origContact; });

test("geocode street address -> approximate false", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.137", lon: "11.575", display_name: "Marienplatz, München", address: { postcode: "80331" } },
  ]), { status: 200 })) as any;
  const r = await geocode("Marienplatz München") as any;
  expect(r.zip).toBe("80331");
  expect(r.approximate).toBe(false);
  expect(r.lat).toBeCloseTo(48.137, 2);
});

test("bare zip -> approximate true", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.14", lon: "11.58", display_name: "80331 München", address: { postcode: "80331" } },
  ]), { status: 200 })) as any;
  const r = await geocode("80331") as any;
  expect(r.approximate).toBe(true);
});

test("no result -> error", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response("[]", { status: 200 })) as any;
  const r = await geocode("zzzznowhere") as any;
  expect(r.error).toBeDefined();
});
```

- [ ] **Step 6: Run the geocode tests**

Run: `cd offers-core && bun test test/geocode.test.ts`
Expected: PASS (4 tests). If the cache from a prior run interferes, the mocked address strings are unique enough to miss cache; no cleanup needed.

- [ ] **Step 7: Commit**

```bash
git add offers-core/src/core/geocode.ts offers-core/test/geocode.test.ts
git commit -m "feat(offers-core): geocode module (Nominatim, zip-centroid approximate flag)"
```

---

### Task 2: `listStores` DB query

Add a filtered read of the `stores` table to `db.ts`. The table already exists (created in `migrate()`); `upsertStores` already writes it.

**Files:**
- Modify: `offers-core/src/core/db.ts`
- Test: `offers-core/test/locate.test.ts` (shared with Task 3)

**Interfaces:**
- Consumes: `Store`, `Scope` from `types.ts`; existing `upsertStores(db, stores)`.
- Produces:
  ```ts
  export interface StoreFilter { retailer?: string; region?: string; scope?: Scope; }
  export function listStores(db: Database, filter: StoreFilter): Store[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// offers-core/test/locate.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertStores, listStores } from "../src/core/db.ts";
import type { Store } from "../src/core/types.ts";

function seed(): import("bun:sqlite").Database {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
    { retailer: "lidl", storeId: "L2", name: "Lidl Nord",  zip: "80807", lat: 48.18,  lon: 11.59,  region: "L2", gln: "", scope: "region" },
    { retailer: "edeka", storeId: "E1", name: "Edeka Süd",  zip: "81541", lat: 48.10,  lon: 11.58,  region: "",   gln: "G1", scope: "store" },
  ];
  upsertStores(db, stores);
  return db;
}

test("listStores filters by retailer", () => {
  const db = seed();
  const lidls = listStores(db, { retailer: "lidl" });
  expect(lidls.length).toBe(2);
  expect(lidls.every((s) => s.retailer === "lidl")).toBe(true);
});

test("listStores no filter returns all", () => {
  expect(listStores(seed(), {}).length).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: FAIL — `listStores` is not exported from `db.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `offers-core/src/core/db.ts` (after `upsertStores`):

```ts
export interface StoreFilter { retailer?: string; region?: string; scope?: Scope; }

export function listStores(db: Database, filter: StoreFilter): Store[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filter.retailer) { clauses.push("retailer = ?"); params.push(filter.retailer); }
  if (filter.region)   { clauses.push("region = ?");   params.push(filter.region); }
  if (filter.scope)    { clauses.push("scope = ?");     params.push(filter.scope); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`
    SELECT retailer, storeId, name, zip, lat, lon, region, gln, scope
    FROM stores ${where}
  `).all(...params) as Store[];
  return rows;
}
```

(Ensure `Store` and `Scope` are imported in `db.ts` — they already are per the existing `upsertStores`/types import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/db.ts offers-core/test/locate.test.ts
git commit -m "feat(offers-core): listStores filtered query over stores table"
```

---

### Task 3: `resolveNearest` + per-retailer key helper

Add the nearest-store lookup and a helper that returns the retailer-correct key field. lidl's key is `region` (= storeKey), edeka's is `gln`, region-scoped retailers use `region`. This is a pure DB read + haversine sort — no network, no fetch.

**Files:**
- Create: `offers-core/src/core/locate.ts`
- Test: `offers-core/test/locate.test.ts` (extend)

**Interfaces:**
- Consumes: `listStores` (Task 2), `haversineKm` from `stores.ts`, `Store` from `types.ts`.
- Produces:
  ```ts
  export interface ResolvedStore extends Store { distKm: number; key: string; }
  export function storeKey(s: Store): string;       // gln for store-scope, region for region/national
  export function resolveNearest(db: Database, retailer: string, lat: number, lon: number, limit?: number): ResolvedStore[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to offers-core/test/locate.test.ts
import { resolveNearest, storeKey } from "../src/core/locate.ts";

test("storeKey: gln for store scope, region otherwise", () => {
  expect(storeKey({ retailer: "edeka", storeId: "E1", name: "", zip: "", lat: 0, lon: 0, region: "", gln: "G1", scope: "store" })).toBe("G1");
  expect(storeKey({ retailer: "lidl", storeId: "L1", name: "", zip: "", lat: 0, lon: 0, region: "L1", gln: "", scope: "region" })).toBe("L1");
});

test("resolveNearest returns lidl stores sorted by distance with key + distKm", () => {
  const db = seed();
  const near = resolveNearest(db, "lidl", 48.137, 11.575); // at Lidl Mitte (L1)
  expect(near.length).toBe(2);
  expect(near[0]!.storeId).toBe("L1");       // closest first
  expect(near[0]!.distKm).toBeLessThan(near[1]!.distKm);
  expect(near[0]!.key).toBe("L1");           // region key for lidl
  expect(near[0]!.distKm).toBeCloseTo(0, 1);
});

test("resolveNearest limit caps result count", () => {
  expect(resolveNearest(seed(), "lidl", 48.137, 11.575, 1).length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: FAIL — `Cannot find module "../src/core/locate.ts"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// offers-core/src/core/locate.ts
import type { Database } from "bun:sqlite";
import type { Store } from "./types.ts";
import { haversineKm } from "./stores.ts";
import { listStores } from "./db.ts";

export interface ResolvedStore extends Store { distKm: number; key: string; }

// ponytail: key field differs by scope — store-scope retailers (edeka) key on gln,
// region/national retailers (lidl, penny, kaufland) key on region/storeKey.
export function storeKey(s: Store): string {
  return s.scope === "store" ? s.gln : s.region;
}

export function resolveNearest(
  db: Database, retailer: string, lat: number, lon: number, limit = 5,
): ResolvedStore[] {
  const stores = listStores(db, { retailer });
  return stores
    .map((s) => ({ ...s, distKm: Number(haversineKm({ lat, lon }, { lat: s.lat, lon: s.lon }).toFixed(2)), key: storeKey(s) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: PASS (5 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/locate.ts offers-core/test/locate.test.ts
git commit -m "feat(offers-core): resolveNearest + per-scope storeKey helper"
```

---

### Task 3b: `populateStores` — live store-location fetch into the DB

**Why this task exists:** `resolveNearest`/`listStores` (Tasks 2–3) read the `stores` table. But nothing in the live path ever writes it — the existing `/stores` route fetches lidl live and throws the result away (`nearestStore` on an in-memory list, no `upsertStores`), and `/sync` writes only kaufland *offers*. `upsertStores` exists in `db.ts` but is called only by tests. So in production `find_stores` returns empty for every retailer — the centerpiece of the new flow is dead. This task adds the populate step that `find_stores` (Task 8) calls before resolving.

Fetching store *locations* is not an offer fetch — the spec's "`resolveNearest` never triggers an offer fetch" is about offers, not locations. `resolveNearest` stays pure (Task 3 unchanged); population is an explicit separate call.

**Files:**
- Modify: `offers-core/src/core/locate.ts`
- Test: `offers-core/test/locate.test.ts` (extend)

**Interfaces:**
- Consumes: `upsertStores` from `db.ts`; `RETAILERS` from `index.ts` (for the per-retailer geo store-fn). `lidlStores(city, lat, lon): Promise<Store[]>` is the only geo-callable fetcher; `edekaMarkets(zip)` is zip-keyed (deferred — needs a zip resolved upstream).
- Produces:
  ```ts
  // fetch a retailer's stores near a point, upsert into the DB, return count written.
  // Only retailers with a geo (lat/lon) store-fn are supported; others throw.
  export async function populateStores(db: Database, retailer: string, lat: number, lon: number): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to offers-core/test/locate.test.ts
import { populateStores } from "../src/core/locate.ts";
import { listStores } from "../src/core/db.ts";

test("populateStores upserts fetched lidl stores, then resolveNearest sees them", async () => {
  const db = openDb(":memory:"); // empty — no seed()
  // stub the retailer geo fetcher: inject via the optional fetcher param (see impl)
  const fakeFetch = async (_c: string, _lat: number, _lon: number) => ([
    { retailer: "lidl", storeId: "L9", name: "Lidl Test", zip: "80331", lat: 48.137, lon: 11.575, region: "L9", gln: "", scope: "region" as const },
  ]);
  const n = await populateStores(db, "lidl", 48.137, 11.575, fakeFetch);
  expect(n).toBe(1);
  expect(listStores(db, { retailer: "lidl" }).length).toBe(1);
});

test("populateStores throws for a retailer with no geo store-fn", async () => {
  const db = openDb(":memory:");
  await expect(populateStores(db, "kaufland", 48.1, 11.5)).rejects.toThrow(/no geo store/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: FAIL — `populateStores is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to offers-core/src/core/locate.ts
import { upsertStores } from "./db.ts";
import { RETAILERS } from "../index.ts";

// ponytail: only lidl exposes a geo (lat/lon) store-fn today. edeka.stores is zip-keyed
// (needs a zip resolved upstream) — wire it in v2 when find_stores resolves a zip via geocode.
// The optional `fetcher` param exists for tests (no live network); prod passes none.
type GeoFetcher = (city: string, lat: number, lon: number) => Promise<Store[]>;
const GEO_FETCHERS: Record<string, GeoFetcher | undefined> = {
  lidl: (RETAILERS as Record<string, any>).lidl?.stores,
};

export async function populateStores(
  db: Database, retailer: string, lat: number, lon: number, fetcher?: GeoFetcher,
): Promise<number> {
  const fetch = fetcher ?? GEO_FETCHERS[retailer];
  if (!fetch) throw new Error(`no geo store-fn for retailer: ${retailer}`);
  const stores = await fetch("", lat, lon);
  upsertStores(db, stores);
  return stores.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offers-core && bun test test/locate.test.ts`
Expected: PASS (7 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/locate.ts offers-core/test/locate.test.ts
git commit -m "feat(offers-core): populateStores — live geo store fetch + upsert"
```

---

### Task 4: Server endpoints `/geocode` and general `/stores`

Replace the lidl-only `/stores` handler with the general filter+nearest version, and add `GET /geocode`. Both read the DB / call geocode; neither fetches offers.

**Files:**
- Modify: `offers-core/src/server.ts`
- Test: `offers-core/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `geocode` (Task 1), `listStores` (Task 2), `resolveNearest` (Task 3).
- Produces: HTTP routes only (no new exported symbols).

- [ ] **Step 1: Write the failing test**

```ts
// append to offers-core/test/server.test.ts
import { upsertStores } from "../src/core/db.ts";
import type { Store } from "../src/core/types.ts";

function seedStores() {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
    { retailer: "lidl", storeId: "L2", name: "Lidl Nord",  zip: "80807", lat: 48.18,  lon: 11.59,  region: "L2", gln: "", scope: "region" },
  ];
  upsertStores(db, stores);
  return db;
}

test("GET /stores?retailer=lidl&lat&lon -> nearest sorted with key + distKm", async () => {
  const app = makeApp(seedStores());
  const res = await app(new Request("http://x/stores?retailer=lidl&lat=48.137&lon=11.575"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0].storeId).toBe("L1");
  expect(body[0].key).toBe("L1");
  expect(typeof body[0].distKm).toBe("number");
});

test("GET /stores?retailer=lidl (no coords) -> listStores", async () => {
  const app = makeApp(seedStores());
  const res = await app(new Request("http://x/stores?retailer=lidl"));
  const body = await res.json();
  expect(body.length).toBe(2);
  expect(body[0].distKm).toBeUndefined(); // listStores, no distance
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd offers-core && bun test test/server.test.ts`
Expected: FAIL — old `/stores` returns the lidl-fetch shape (`{retailer, nearest}` or `{retailer, scope}`), not the array with `storeId`/`key`/`distKm`.

- [ ] **Step 3: Write minimal implementation**

In `offers-core/src/server.ts`: update imports and replace the `/stores` block; add `/geocode`.

Change the import line:
```ts
import { nearestStore } from "./core/stores.ts";
```
to:
```ts
import { listStores } from "./core/db.ts";
import { resolveNearest, populateStores } from "./core/locate.ts";
import { geocode } from "./core/geocode.ts";
```
(Remove the now-unused `nearestStore` import if nothing else uses it — check the file; if used elsewhere keep it.)

Replace the entire `if (... "/stores")` block with:
```ts
    if (req.method === "GET" && url.pathname === "/stores") {
      const retailer = p.get("retailer") ?? undefined;
      const region = p.get("region") ?? undefined;
      const scope = (p.get("scope") ?? undefined) as Scope | undefined;
      const lat = num(p.get("lat")), lon = num(p.get("lon"));
      if (retailer && lat !== undefined && lon !== undefined) {
        const limit = num(p.get("limit"));
        // populate the stores table from the live geo store-fn before resolving — same
        // populate-then-resolve the MCP find_stores does. Without it the table is empty and
        // /stores returns nothing. Swallow failure (no geo fn / network down), resolve cache.
        try { await populateStores(db, retailer, lat, lon); } catch { /* fall through to cached */ }
        return Response.json(resolveNearest(db, retailer, lat, lon, limit));
      }
      return Response.json(listStores(db, { retailer, region, scope }));
    }
```
> The `seedStores()` test pre-seeds the DB; offline `populateStores` throws and is swallowed, so the seeded rows resolve. No live network in the test.

Add a `/geocode` route (place near the other GET routes):
```ts
    if (req.method === "GET" && url.pathname === "/geocode") {
      const q = p.get("q") ?? "";
      return Response.json(await geocode(q));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd offers-core && bun test test/server.test.ts`
Expected: PASS. (The two new tests + all prior server tests still green.)

- [ ] **Step 5: Run the whole offers-core suite + typecheck**

Run: `cd offers-core && bun test && bunx tsc --noEmit`
Expected: all tests pass; tsc clean (exit 0). If `nearestStore` is now unused and tsc/noUnusedLocals complains, remove its import.

- [ ] **Step 6: Commit**

```bash
git add offers-core/src/server.ts offers-core/test/server.test.ts
git commit -m "feat(offers-core): /geocode + general /stores (filter + nearest), replace lidl-only stores route"
```

---

### Task 5: Re-export location layer, update offers-core README + version, prepare for extraction

Add the package-root re-exports the MCP (Phase B) imports, document the new location layer, and bump the version. **The re-exports MUST land here, before the Task 6 tag** — groceries-mcp imports them from the package root of the pinned tag; if they're missing the tag has to be re-cut. Do NOT yet flip `private` — that happens at extraction (Task 6) which is a Captain-gated repo operation.

**Files:**
- Modify: `offers-core/src/index.ts`
- Modify: `offers-core/README.md`
- Modify: `offers-core/package.json`

**Interfaces:**
- Produces (package-root exports consumed by Phase B Task 8): `geocode`, `listStores`, `upsertStores`, `weekCount`, `resolveNearest`, `storeKey`, `populateStores`, `isoWeekKey`, `StoreFilter`, `ResolvedStore`, `Store` — in addition to the already-present `openDb`, `syncOne`, `RETAILERS`, `getOffers`, `getOfferDetails`, `OfferQuery`.

- [ ] **Step 1: Add the location-layer re-exports to `src/index.ts`**

Append to `offers-core/src/index.ts` (the existing `export { openDb, syncOne }` etc. stay):
```ts
export { geocode } from "./core/geocode.ts";
export { listStores, upsertStores, weekCount, type StoreFilter } from "./core/db.ts";
export { resolveNearest, storeKey, populateStores, type ResolvedStore } from "./core/locate.ts";
export { isoWeekKey } from "./core/week.ts";
export type { Store } from "./core/types.ts";
```
Verify it compiles and the symbols resolve:
```bash
cd offers-core && bunx tsc --noEmit && bun -e 'import("./src/index.ts").then(m => { for (const s of ["geocode","listStores","upsertStores","weekCount","resolveNearest","storeKey","populateStores","isoWeekKey"]) if (typeof m[s] !== "function") throw new Error("missing export: "+s); console.log("all location exports present"); })'
```
Expected: tsc clean; prints `all location exports present`.

- [ ] **Step 2: Bump version**

In `offers-core/package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"` (the location layer is a feature release).

- [ ] **Step 3: Document the location layer in README**

Add a section to `offers-core/README.md` after the existing endpoints:

````markdown
### `GET /geocode` — address/zip → coordinates

`q` = free-text German address or a 5-digit zip. Returns `{lat, lon, zip, approximate, displayName}`
or `{error, candidates?}`. A bare zip resolves to the postcode centroid with `approximate: true`
(coarse — pass a full address for accurate distance). Requires `WEEKPLAN_CONTACT` env (Nominatim policy).

```bash
curl 'http://localhost:3000/geocode?q=Marienplatz+München'
```

### `GET /stores` — list / nearest store lookup

With `retailer`+`lat`+`lon` (+ optional `limit`): nearest stores sorted by straight-line
`distKm`, each carrying its retailer `key`. Without coords: filtered list (`retailer`, `region`,
`scope`). Pure lookup — never fetches offers.

```bash
curl 'http://localhost:3000/stores?retailer=lidl&lat=48.137&lon=11.575'
```
````

- [ ] **Step 4: Run the suite (re-export + docs shouldn't break anything)**

Run: `cd offers-core && bun test && bunx tsc --noEmit`
Expected: all pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/index.ts offers-core/README.md offers-core/package.json
git commit -m "feat(offers-core): re-export location layer; document it; bump to 0.2.0"
```

---

### Task 6: Extract offers-core to its own repo + tag (Captain-gated)

> **STOP — this task performs irreversible/outward git operations (creating a GitHub repo, pushing history). Per the worktree + push-consent rules, surface the exact commands to the Captain and get a go-ahead before running them. This is the one task an implementer must NOT auto-run; the controller executes it with the Captain.**

**Goal:** Create `github.com/AdeAnima/offers-core` containing the `offers-core/` subtree WITH history, tag `v0.2.0`, push. Then groceries-mcp (Phase B) consumes it as a git dep.

**Files:** none in this repo's working tree (git history operation).

- [ ] **Step 1: Confirm gh auth + repo absence**

```bash
gh auth status
gh repo view AdeAnima/offers-core 2>/dev/null && echo "EXISTS — stop, decide" || echo "absent — ok to create"
```

- [ ] **Step 2: Split the subtree with history (preferred: git subtree split)**

```bash
cd /Users/marten/Code/ade_anima/food-planner
git subtree split --prefix=offers-core -b offers-core-export
# verify the export branch has only offers-core/ content at root
git log --oneline offers-core-export | head
```

- [ ] **Step 3: Create the repo and push the split branch as main**

```bash
gh repo create AdeAnima/offers-core --private --description "German supermarket offers: fetch, persist, serve."
git push git@github.com:AdeAnima/offers-core.git offers-core-export:main
```

- [ ] **Step 4: Tag the release in the new repo**

Clone fresh (or push a tag to the split branch), flip `private`, tag:
```bash
cd /tmp && git clone git@github.com:AdeAnima/offers-core.git && cd offers-core
# flip "private": true -> remove or false in package.json (it's now its own repo)
# (edit package.json)
git add package.json && git commit -m "chore: unmark private for standalone repo"
git tag v0.2.0 && git push origin main --tags
```

- [ ] **Step 5: Record the tag for Phase B**

The git dep string for groceries-mcp is:
`git+ssh://git@github.com:AdeAnima/offers-core.git#v0.2.1`

- [ ] **Step 6: Decide the fate of the in-repo `offers-core/` folder (Captain)**

Options (Captain decides; do NOT auto-delete):
- Keep the folder as the canonical dev copy and sync to the export repo on release (simplest near-term).
- Remove it from food-planner now that it's a published dep (cleaner, but the merged `main` history retains it).

Default for this plan: **keep the folder**, treat the standalone repo as the published-dependency mirror. Revisit when groceries-mcp is proven against the tag.

---

## Phase B — groceries-mcp

### Task 7: Scaffold groceries-mcp package

Create the package skeleton matching the cookidoo-mcp / supermarkets-mcp layout, with the offers-core git dep.

**Files:**
- Create: `mcp-servers/groceries-mcp/package.json`
- Create: `mcp-servers/groceries-mcp/tsconfig.json`
- Create: `mcp-servers/groceries-mcp/src/index.ts` (stub that boots an empty server)

**Interfaces:**
- Produces: an installable, bootable MCP server (no tools yet).

- [ ] **Step 1: Write package.json**

```json
{
  "name": "groceries-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch src/index.ts",
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.8",
    "offers-core": "git+ssh://git@github.com:AdeAnima/offers-core.git#v0.2.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json (mirror supermarkets-mcp)**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  }
}
```

- [ ] **Step 3: Write the boot stub**

```ts
// mcp-servers/groceries-mcp/src/index.ts
#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "groceries-mcp", version: "0.1.0" });

// tools registered in Task 9

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("groceries-mcp started");
```

- [ ] **Step 4: Install deps and verify it boots**

```bash
cd mcp-servers/groceries-mcp && bun install && timeout 2 bun run src/index.ts
```
Expected: `bun install` resolves the offers-core git dep (requires the v0.2.0 tag from Task 6 to exist). The server prints `groceries-mcp started` to stderr then is killed by `timeout`. Exit due to timeout is fine.

> If Task 6 has not been run yet, `bun install` of the git dep FAILS. The implementer must STOP and report — Phase B depends on Phase A's published tag.

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/groceries-mcp/package.json mcp-servers/groceries-mcp/tsconfig.json mcp-servers/groceries-mcp/src/index.ts
git commit -m "feat(groceries-mcp): scaffold package + offers-core git dep + boot stub"
```

---

### Task 8: Handlers module (offers-core calls, testable without MCP)

Put the actual offers-core calls in a separate `handlers.ts` so they can be unit-tested with an in-memory DB, without standing up the MCP transport.

**Files:**
- Create: `mcp-servers/groceries-mcp/src/handlers.ts`
- Test: `mcp-servers/groceries-mcp/test/handlers.test.ts`

**Interfaces:**
- Consumes (from the `offers-core` package): `openDb`, `getOffers`, `getOfferDetails`, `syncOne`, `weekCount`, `isoWeekKey`, `RETAILERS`, and the location layer `geocode`, `resolveNearest`, `listStores`, `populateStores`. (These are exported from offers-core's `src/index.ts` and `src/core/*`. Phase A confirmed they exist; the package's entry must re-export them — see Step 1.)
- Produces:
  ```ts
  export function makeHandlers(db: Database): {
    geocode(q: string): Promise<unknown>;
    findStores(retailer: string, lat: number, lon: number, limit?: number): Promise<unknown>;
    fetchOffers(retailer: string, key?: string): Promise<unknown>;
    searchOffers(q: OfferQuery): unknown;
    getOffer(retailer: string, key: string, offerId: string, validFrom: string, groups?: string[]): unknown;
  };
  ```
  `findStores` is **async**: it populates the `stores` table (live geo fetch via `populateStores`) before resolving, so it works on an empty DB.

- [ ] **Step 1: Verify the offers-core tag re-exports the location layer**

The location-layer re-exports were added to offers-core `src/index.ts` in Phase A Task 5 (before the v0.2.0 tag). Confirm they resolve from the installed package (Task 7 ran `bun install` against the pinned tag):
```bash
cd mcp-servers/groceries-mcp && bun -e 'import("offers-core").then(m => { for (const s of ["geocode","resolveNearest","listStores","populateStores","weekCount","isoWeekKey","upsertStores","getOffers","getOfferDetails","syncOne"]) if (typeof m[s] !== "function") throw new Error("missing export from offers-core tag: "+s); console.log("offers-core exports OK"); })'
```
Expected: prints `offers-core exports OK`.
> If any symbol is missing, the pinned tag predates the Task 5 re-exports — re-cut the tag (v0.2.1) in offers-core and bump the dep in `package.json`, then re-run `bun install`. Do NOT add deep `offers-core/src/...` imports as a workaround.

- [ ] **Step 2: Write the failing test**

```ts
// mcp-servers/groceries-mcp/test/handlers.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertStores } from "offers-core";
import type { Store } from "offers-core";
import { makeHandlers } from "../src/handlers.ts";

function seed() {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
  ];
  upsertStores(db, stores);
  return db;
}

test("findStores returns nearest with key + distKm (pre-seeded; populate fails offline, falls through)", async () => {
  // DB pre-seeded by seed(). populateStores would hit the network for lidl; offline it
  // throws and findStores swallows it, then resolves the already-present rows. No live network.
  const h = makeHandlers(seed());
  const r = (await h.findStores("lidl", 48.137, 11.575)) as any[];
  expect(r[0].key).toBe("L1");
  expect(typeof r[0].distKm).toBe("number");
});

test("searchOffers on empty DB returns empty array", () => {
  const h = makeHandlers(seed());
  expect((h.searchOffers({ retailers: ["lidl"] }) as any[]).length).toBe(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mcp-servers/groceries-mcp && bun test`
Expected: FAIL — `Cannot find module "../src/handlers.ts"`. (Requires `bun install` done in Task 7, and the offers-core re-exports from Step 1.)

- [ ] **Step 4: Write the implementation**

```ts
// mcp-servers/groceries-mcp/src/handlers.ts
import type { Database } from "bun:sqlite";
import {
  getOffers, getOfferDetails, syncOne, weekCount, isoWeekKey, RETAILERS,
  geocode, resolveNearest, populateStores, listStores,
  type OfferQuery,
} from "offers-core";

export function makeHandlers(db: Database) {
  return {
    async geocode(q: string) { return geocode(q); },

    async findStores(retailer: string, lat: number, lon: number, limit?: number) {
      // Populate the stores table from the live geo store-fn ONLY when it's empty for this
      // retailer, THEN resolve. resolveNearest stays a pure DB read. Fetching locations is not
      // an offer fetch. ponytail: store locations are near-static — populate once on a cold DB,
      // not on every call (an MCP would otherwise hit the live retailer API per lookup). Seeded
      // tests skip populate entirely → no live network. Add a fetchedAt TTL if locations drift.
      if (listStores(db, { retailer }).length === 0) {
        try { await populateStores(db, retailer, lat, lon); } catch { /* no geo fn / offline */ }
      }
      return resolveNearest(db, retailer, lat, lon, limit);
    },

    async fetchOffers(retailer: string, key?: string) {
      const r = (RETAILERS as Record<string, any>)[retailer];
      if (!r) return { error: `unknown retailer: ${retailer}` };
      const wk = isoWeekKey(new Date().toISOString().slice(0, 10));
      if (retailer === "kaufland") {
        const prev = weekCount(db, "kaufland", "national", wk);
        return syncOne(db, "kaufland", "national", r.scope, r.offers, wk, prev)
          .catch((e: Error) => ({ retailer, error: e.message }));
      }
      if (!key) return { retailer, error: "needs key resolution (call find_stores first)" };
      // ponytail: keyed fetch — the retailer offers-fn takes its key; arity differs per retailer,
      // so bind concretely. groceries v1 wires lidl (region key) end-to-end. edeka/penny/marktguru/
      // rewe have no store-fetcher to produce a key (or need extra args), so they can't complete the
      // flow — loud error, never an undefined-key fetch.
      if (retailer === "lidl") {
        const prev = weekCount(db, "lidl", key, wk);
        return syncOne(db, "lidl", key, r.scope, () => r.offers(key), wk, prev)
          .catch((e: Error) => ({ retailer, error: e.message }));
      }
      return { retailer, error: `keyed fetch not yet wired for ${retailer}` };
    },

    searchOffers(q: OfferQuery) { return getOffers(db, q); },

    getOffer(retailer: string, key: string, offerId: string, validFrom: string, groups?: string[]) {
      return getOfferDetails(db, retailer, key, offerId, validFrom, (groups ?? ["all"]) as any);
    },
  };
}
```
> NOTE: every symbol imported here (`syncOne`, `weekCount`, `isoWeekKey`, `RETAILERS`, `geocode`, `resolveNearest`, `populateStores`, `getOffers`, `getOfferDetails`, `OfferQuery`) is re-exported from the offers-core package root per Step 1 — no deep `offers-core/src/...` imports. Verify they all resolve from `"offers-core"` before running the test.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp-servers/groceries-mcp && bun test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add mcp-servers/groceries-mcp/src/handlers.ts mcp-servers/groceries-mcp/test/handlers.test.ts
git commit -m "feat(groceries-mcp): handlers over offers-core (geocode, find_stores, fetch_offers, search, detail)"
```

---

### Task 9: Register the 5 MCP tools

Wire the handlers into MCP tools with zod schemas, mirroring supermarkets-mcp's `server.registerTool` pattern. The DB is opened once and shared.

**Files:**
- Modify: `mcp-servers/groceries-mcp/src/index.ts`

**Interfaces:**
- Consumes: `makeHandlers` (Task 8), `openDb` (offers-core).
- Produces: a running MCP server exposing `geocode`, `find_stores`, `fetch_offers`, `search_offers`, `get_offer`.

- [ ] **Step 1: Write the full index.ts**

```ts
// mcp-servers/groceries-mcp/src/index.ts
#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "offers-core";
import { makeHandlers } from "./handlers.ts";

const db = openDb();
const h = makeHandlers(db);
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "groceries-mcp", version: "0.1.0" });

server.registerTool("geocode", {
  title: "Geocode a German address or zip to coordinates",
  description: "Resolves a free-text German address OR a 5-digit zip to {lat, lon, zip, approximate}. A bare zip returns the postcode centroid with approximate:true (coarse). Use before find_stores.",
  inputSchema: { q: z.string().describe("German address or 5-digit zip") },
}, async ({ q }) => text(await h.geocode(q)));

server.registerTool("find_stores", {
  title: "Find nearest supermarket stores to coordinates",
  description: "Returns the nearest stores of a retailer to lat/lon, sorted by straight-line distance, each with its retailer `key` (needed for fetch_offers). Pure lookup — does not fetch offers.",
  inputSchema: {
    retailer: z.string().describe("retailer slug, e.g. lidl, edeka, penny"),
    lat: z.number(), lon: z.number(),
    limit: z.number().int().positive().optional().describe("max stores (default 5)"),
  },
}, async ({ retailer, lat, lon, limit }) => text(await h.findStores(retailer, lat, lon, limit)));

server.registerTool("fetch_offers", {
  title: "Fetch a store's current offers into the local DB",
  description: "Fetches the current weekly offers for a retailer (and store key) from the live retailer API and stores them (append-only). Keyed retailers (lidl, edeka, …) require `key` from find_stores; kaufland is national and ignores key. Call before search_offers.",
  inputSchema: {
    retailer: z.string(),
    key: z.string().optional().describe("store/region key from find_stores; omit for kaufland"),
  },
}, async ({ retailer, key }) => text(await h.fetchOffers(retailer, key)));

server.registerTool("search_offers", {
  title: "Search current offers in the local DB",
  description: "Reads slim offers already fetched into the DB. Filters: retailers, category, priceMin/priceMax (integer cents), foodOnly, q (title search), validOn, weekKey. Returns offers valid today unless a date/week is pinned.",
  inputSchema: {
    retailers: z.array(z.string()).optional(),
    category: z.array(z.string()).optional(),
    priceMin: z.number().int().optional(), priceMax: z.number().int().optional(),
    foodOnly: z.boolean().optional(),
    q: z.string().optional(),
    validOn: z.string().optional(), weekKey: z.string().optional(),
    storeOrRegionKey: z.string().optional(), scope: z.string().optional(),
  },
}, async (args) => text(h.searchOffers(args)));

server.registerTool("get_offer", {
  title: "Get full detail for one offer",
  description: "Returns selected info groups for a single offer by its full composite key (retailer, key, offerId, validFrom). groups: pricing, classification, media, raw, all (default all).",
  inputSchema: {
    retailer: z.string(), key: z.string(), offerId: z.string(), validFrom: z.string(),
    groups: z.array(z.enum(["pricing", "classification", "media", "raw", "all"])).optional(),
  },
}, async ({ retailer, key, offerId, validFrom, groups }) => text(h.getOffer(retailer, key, offerId, validFrom, groups)));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("groceries-mcp started");
```

- [ ] **Step 2: Typecheck**

Run: `cd mcp-servers/groceries-mcp && bunx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 3: Boot smoke test**

Run: `cd mcp-servers/groceries-mcp && timeout 2 bun run src/index.ts`
Expected: prints `groceries-mcp started` to stderr, killed by timeout. (Opening the DB creates `data/offers.db`; that's fine.)

- [ ] **Step 4: Run handler tests once more (regression)**

Run: `cd mcp-servers/groceries-mcp && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/groceries-mcp/src/index.ts
git commit -m "feat(groceries-mcp): register geocode, find_stores, fetch_offers, search_offers, get_offer tools"
```

---

### Task 10: README + register the server (MCP config)

Document groceries-mcp and add it to the project's MCP server config so Claude can load it. Do NOT yet delete supermarkets-mcp (that's sub-project 3).

**Files:**
- Create: `mcp-servers/groceries-mcp/README.md`
- Modify: the project MCP config that lists servers (locate it; likely `.mcp.json` or an `mcpServers` block — the implementer greps for where `cookidoo` / `supermarkets-mcp` are registered and mirrors that entry).

**Interfaces:** none (docs + config).

- [ ] **Step 1: Locate the MCP registration**

```bash
grep -rl "supermarkets-mcp\|cookidoo" --include="*.json" /Users/marten/Code/ade_anima/food-planner/.claude/worktrees/food-planner-plugin-fix | grep -iE "mcp|config" | head
```
Find the file that registers the existing servers (command + args). If none exists at repo level (servers may be user-scoped), STOP and report — registration location is a Captain decision.

- [ ] **Step 2: Add the groceries-mcp entry**

Mirror the existing entry shape. Typical form:
```json
"groceries-mcp": {
  "command": "bun",
  "args": ["run", "/Users/marten/Code/ade_anima/food-planner/mcp-servers/groceries-mcp/src/index.ts"],
  "env": { "WEEKPLAN_CONTACT": "martin@westphal.pw" }
}
```

- [ ] **Step 3: Write README**

```markdown
# groceries-mcp

MCP server exposing German-supermarket offers + store locations to Claude.
Thin wrapper over the `offers-core` library (imported as a git dependency).

## Tools
- `geocode(q)` — address/zip → lat/lon/zip/approximate
- `find_stores(retailer, lat, lon, limit?)` — nearest stores + keys + distance (no fetch)
- `fetch_offers(retailer, key?)` — fetch a store's current offers into the DB
- `search_offers(...)` — read slim offers from the DB
- `get_offer(retailer, key, offerId, validFrom, groups?)` — full offer detail

## Flow
geocode → find_stores → fetch_offers (per store) → search_offers.
Kaufland is national: skip geocode/find_stores, call fetch_offers("kaufland").

## Env
- `WEEKPLAN_CONTACT` (required) — your email/URL, for Nominatim/Overpass User-Agent policy.

## Dev
```bash
bun install
bun test
bun run start
```
```

- [ ] **Step 4: Commit**

```bash
git add mcp-servers/groceries-mcp/README.md
git commit -m "docs(groceries-mcp): README + MCP server registration"
```

---

## Final whole-branch review

After Task 10, dispatch the final adversarial code review (per subagent-driven-development) over the whole Phase A + Phase B diff. Lenses to include: price-contract preservation, append-only invariant, the per-retailer key/arity escape-hatch class (the offers-core T17 bug class — scrutinize `fetchOffers`'s retailer branching and any `as any`/`as Record`), SQL/3VL in `listStores`, secrets/env (WEEKPLAN_CONTACT, no hardcoded creds). Then `superpowers:finishing-a-development-branch`.

---

## Notes on dependencies between phases

- **Phase B cannot `bun install` until Phase A's tag (Task 6) is published.** Tasks 7–10 depend on the git dep resolving.
- **The offers-core package-root re-exports (Task 8 Step 1) must land in offers-core BEFORE the tag is cut.** If the tag is cut in Task 6 without them, re-cut as v0.2.1 and update the dep string in Task 7. Best: verify the re-export list (Task 8 Step 1) is in `offers-core/src/index.ts` as part of Task 4/5, so Task 6 tags a complete package.
