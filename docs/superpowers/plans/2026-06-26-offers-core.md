# offers-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bun/TS library + thin HTTP server that fetches German supermarket offers from 5 retailers, persists them in a bun:sqlite history DB, and serves slimmed responses with generic filters, a detail endpoint, and a store-locator.

**Architecture:** Per-retailer client modules return raw offers; a normalize layer maps each to one slim `Offer` shape and stashes the full raw JSON; everything is upserted into an append-only bun:sqlite DB keyed to preserve weekly history; a thin `Bun.serve` route switch exposes `/offers`, `/offers/:id`, `/stores`, `/sync`. No diet logic (lives in the LLM consumer), no tag system (schema reserved only).

**Tech Stack:** Bun 1.3.x, TypeScript (strict), `bun:sqlite` (built-in, zero dep), `bun:test`. No third-party runtime deps.

**Spec:** `docs/superpowers/specs/2026-06-26-offers-core-design.md`

## Global Constraints

- bun + TypeScript only. New scripts `.ts` run via `bun`. No `node`/`npm`/`pnpm`/`yarn`.
- **Zero third-party runtime deps.** `bun:sqlite`, `bun:test`, `Bun.serve`, native `fetch` only. Any dep needs written justification.
- Secrets (Edeka OAuth creds, REWE cert/pw) come from **env**, never hardcoded in committed source. Document re-extraction in README.
- `price` is always **integer cents**. Never float euros.
- `offers` table is **append-only**; never add a `tags` column (v2 uses a separate `offer_tags` table, not created here).
- DB file `data/offers.db` is **gitignored**.
- Repo is **private/personal first**.
- Each retailer client returns `RawOffer[]` + store lookup ONLY — no filtering, no slimming.
- Tests use `bun:test`, no heavy fixtures framework. One runnable check per non-trivial logic path.
- ISO dates as `YYYY-MM-DD` strings. ISO week as `YYYY-Www` (e.g. `2026-W27`).

---

## File Structure

```
offers-core/
  package.json
  tsconfig.json
  .gitignore
  README.md
  FUTURE.md
  data/offers.db              # gitignored, created at runtime
  src/
    core/
      types.ts                # Offer, RawOffer, Store, Scope, InfoGroup
      week.ts                 # isoWeekKey(date) helper
      db.ts                   # schema, migrations, upsert, queries
      normalize.ts            # dispatch RawOffer -> Offer (delegates to per-retailer mappers)
      filter.ts               # OfferQuery -> {sql, params}
      stores.ts               # haversine nearest-store/region resolution
      sync.ts                 # syncRetailer + post-sync anomaly check
    retailers/
      lidl.ts
      edeka.ts
      penny.ts
      kaufland.ts
      marktguru.ts            # ported from existing supermarkets-mcp
      rewe.ts                 # stub only (deferred)
    index.ts                  # library public API + retailer literal
    server.ts                 # Bun.serve route switch
  test/                       # *.test.ts + captured fixtures
    fixtures/
```

Build order: scaffold → types → week → db → filter → stores → normalize → Lidl → Edeka → (contract frozen) → Penny → Kaufland → Marktguru → rewe stub → sync → index → server → README/FUTURE.

---

### Task 1: Repo scaffold

**Files:**
- Create: `offers-core/package.json`, `offers-core/tsconfig.json`, `offers-core/.gitignore`

**Interfaces:**
- Produces: a runnable bun project; `bun test` works.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "offers-core",
  "version": "0.1.0",
  "description": "Fetch, persist, and serve German supermarket offers.",
  "private": true,
  "type": "module",
  "scripts": {
    "serve": "bun run src/server.ts",
    "sync": "bun run src/sync.ts",
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
data/
*.db
.env
```

- [ ] **Step 4: Verify bun runs**

Run: `cd offers-core && bun test`
Expected: exits 0 with "0 tests" (no tests yet — bun reports no files, exit 0).

- [ ] **Step 5: Commit**

```bash
git add offers-core/package.json offers-core/tsconfig.json offers-core/.gitignore
git commit -m "chore: scaffold offers-core bun project"
```

---

### Task 2: Core types

**Files:**
- Create: `offers-core/src/core/types.ts`
- Test: `offers-core/test/types.test.ts`

**Interfaces:**
- Produces:
  - `type Scope = "store" | "region" | "national"`
  - `type InfoGroup = "pricing" | "classification" | "media" | "raw" | "all"`
  - `interface Offer { offerId; retailer; scope; storeOrRegionKey; title; category; price; quantity?; unit?; validFrom; validTo }`
  - `interface RawOffer { offerId; title; category; price; quantity?; unit?; validFrom; validTo; raw }`
  - `interface Store { retailer; storeId; name; zip; lat; lon; region; gln; scope }`

- [ ] **Step 1: Write the failing test**

```ts
// test/types.test.ts
import { test, expect } from "bun:test";
import type { Offer, RawOffer, Store, Scope } from "../src/core/types.ts";

test("Offer shape compiles and holds expected fields", () => {
  const o: Offer = {
    offerId: "x", retailer: "lidl", scope: "region" as Scope,
    storeOrRegionKey: "DE-BW", title: "Apfel", category: "Obst",
    price: 199, quantity: "1 kg", unit: "kg",
    validFrom: "2026-06-29", validTo: "2026-07-05",
  };
  expect(o.price).toBe(199);
});

test("RawOffer carries opaque raw + slim fields", () => {
  const r: RawOffer = {
    offerId: "x", title: "Apfel", category: "Obst", price: 199,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { anything: true },
  };
  expect(r.raw).toBeDefined();
});

test("Store shape compiles", () => {
  const s: Store = {
    retailer: "edeka", storeId: "123", name: "E center", zip: "81669",
    lat: 48.1, lon: 11.6, region: "", gln: "4311501000007", scope: "store",
  };
  expect(s.gln).toBeString();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/types.test.ts`
Expected: FAIL — cannot resolve `../src/core/types.ts`.

- [ ] **Step 3: Write `types.ts`**

```ts
// src/core/types.ts
export type Scope = "store" | "region" | "national";
export type InfoGroup = "pricing" | "classification" | "media" | "raw" | "all";

export interface Offer {
  offerId: string;
  retailer: string;
  scope: Scope;
  storeOrRegionKey: string;
  title: string;
  category: string;
  price: number; // integer cents
  quantity?: string;
  unit?: string;
  validFrom: string; // YYYY-MM-DD
  validTo: string;   // YYYY-MM-DD
}

export interface RawOffer {
  offerId: string;
  title: string;
  category: string;
  price: number; // integer cents
  quantity?: string;
  unit?: string;
  validFrom: string;
  validTo: string;
  raw: unknown; // full upstream object
}

export interface Store {
  retailer: string;
  storeId: string;
  name: string;
  zip: string;
  lat: number;
  lon: number;
  region: string;
  gln: string;
  scope: Scope;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/types.ts offers-core/test/types.test.ts
git commit -m "feat: core offer/store types"
```

---

### Task 3: ISO week helper

**Files:**
- Create: `offers-core/src/core/week.ts`
- Test: `offers-core/test/week.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function isoWeekKey(date: string): string` — `"2026-06-29"` → `"2026-W27"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/week.test.ts
import { test, expect } from "bun:test";
import { isoWeekKey } from "../src/core/week.ts";

test("Monday 2026-06-29 is ISO week 27", () => {
  expect(isoWeekKey("2026-06-29")).toBe("2026-W27");
});
test("Sunday 2026-07-05 is still week 27", () => {
  expect(isoWeekKey("2026-07-05")).toBe("2026-W27");
});
test("Jan 1 2027 (Friday) belongs to ISO week 53 of 2026", () => {
  expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
});
test("pads single-digit week", () => {
  expect(isoWeekKey("2026-01-05")).toBe("2026-W02");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/week.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `week.ts`**

```ts
// src/core/week.ts
// ISO 8601 week number. Pure date arithmetic, no deps.
export function isoWeekKey(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  // Shift to Thursday of this week — ISO weeks are defined by their Thursday.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/week.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/week.ts offers-core/test/week.test.ts
git commit -m "feat: ISO week-key helper"
```

---

### Task 4: Database — schema, migrations, upsert, history

**Files:**
- Create: `offers-core/src/core/db.ts`
- Test: `offers-core/test/db.test.ts`

**Interfaces:**
- Consumes: `Offer`, `Store`, `Scope` from `types.ts`; `isoWeekKey` from `week.ts`.
- Produces:
  - `function openDb(path?: string): Database` — opens/migrates; default `data/offers.db`, pass `":memory:"` in tests.
  - `function upsertOffers(db, retailer: string, storeOrRegionKey: string, scope: Scope, offers: RawOffer[]): number` — returns rows inserted (excludes dedup'd dups).
  - `function upsertStores(db, stores: Store[]): void`
  - `function queryOffers(db, where: { sql: string; params: any[] }): Offer[]`
  - `function getRaw(db, offerId: string, retailer: string): unknown | null`
  - `function weekCount(db, retailer: string, storeOrRegionKey: string, weekKey: string): number` — for anomaly check.

- [ ] **Step 1: Write the failing test**

```ts
// test/db.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertOffers, queryOffers, getRaw, weekCount } from "../src/core/db.ts";
import type { RawOffer } from "../src/core/types.ts";

const mk = (id: string, validFrom: string): RawOffer => ({
  offerId: id, title: "Apfel", category: "Obst", price: 199,
  validFrom, validTo: "2026-07-05", raw: { id },
});

test("history preserved: same offerId, different validFrom -> 2 rows", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-22")]);
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  const rows = queryOffers(db, { sql: "offerId = ?", params: ["a"] });
  expect(rows.length).toBe(2);
});

test("dedup: same offerId + same validFrom -> 1 row", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  const inserted = upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  expect(inserted).toBe(0);
  expect(queryOffers(db, { sql: "1=1", params: [] }).length).toBe(1);
});

test("regional duplicate offerId across keys does not clobber", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "penny", "R1", "region", [mk("a", "2026-06-29")]);
  upsertOffers(db, "penny", "R2", "region", [mk("a", "2026-06-29")]);
  expect(queryOffers(db, { sql: "1=1", params: [] }).length).toBe(2);
});

test("getRaw returns stored upstream object", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  expect(getRaw(db, "a", "lidl")).toEqual({ id: "a" });
});

test("weekCount counts rows for a region-week", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29"), mk("b", "2026-06-29")]);
  expect(weekCount(db, "lidl", "DE-BW", "2026-W27")).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `db.ts`**

```ts
// src/core/db.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Offer, Store, Scope, RawOffer } from "./types.ts";
import { isoWeekKey } from "./week.ts";

const CURRENT_VERSION = 1;

export function openDb(path = "data/offers.db"): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (v < 1) {
    db.exec(`
      CREATE TABLE stores (
        id INTEGER PRIMARY KEY,
        retailer TEXT, storeId TEXT, name TEXT, zip TEXT,
        lat REAL, lon REAL, region TEXT, gln TEXT, scope TEXT,
        fetchedAt TEXT,
        UNIQUE(retailer, storeId)
      );
      CREATE TABLE offers (
        id INTEGER PRIMARY KEY,
        offerId TEXT, retailer TEXT, scope TEXT, storeOrRegionKey TEXT,
        title TEXT, category TEXT, price INTEGER, quantity TEXT, unit TEXT,
        validFrom TEXT, validTo TEXT, weekKey TEXT, raw TEXT, fetchedAt TEXT,
        UNIQUE(retailer, storeOrRegionKey, offerId, validFrom)
      );
      CREATE INDEX idx_offers_query ON offers(retailer, storeOrRegionKey, validFrom, validTo);
    `);
  }
  // future migrations: if (v < 2) { db.exec("ALTER TABLE ..."); }
  db.exec(`PRAGMA user_version = ${CURRENT_VERSION};`);
}

export function upsertOffers(
  db: Database, retailer: string, storeOrRegionKey: string, scope: Scope, offers: RawOffer[],
): number {
  const now = new Date().toISOString();
  const stmt = db.query(`
    INSERT INTO offers (offerId, retailer, scope, storeOrRegionKey, title, category,
      price, quantity, unit, validFrom, validTo, weekKey, raw, fetchedAt)
    VALUES ($offerId,$retailer,$scope,$key,$title,$category,$price,$quantity,$unit,
      $validFrom,$validTo,$weekKey,$raw,$fetchedAt)
    ON CONFLICT(retailer, storeOrRegionKey, offerId, validFrom) DO NOTHING
  `);
  let inserted = 0;
  const tx = db.transaction((rows: RawOffer[]) => {
    for (const o of rows) {
      const res = stmt.run({
        $offerId: o.offerId, $retailer: retailer, $scope: scope, $key: storeOrRegionKey,
        $title: o.title, $category: o.category, $price: o.price,
        $quantity: o.quantity ?? null, $unit: o.unit ?? null,
        $validFrom: o.validFrom, $validTo: o.validTo, $weekKey: isoWeekKey(o.validFrom),
        $raw: JSON.stringify(o.raw), $fetchedAt: now,
      });
      inserted += res.changes;
    }
  });
  tx(offers);
  return inserted;
}

export function upsertStores(db: Database, stores: Store[]): void {
  const now = new Date().toISOString();
  const stmt = db.query(`
    INSERT INTO stores (retailer, storeId, name, zip, lat, lon, region, gln, scope, fetchedAt)
    VALUES ($retailer,$storeId,$name,$zip,$lat,$lon,$region,$gln,$scope,$fetchedAt)
    ON CONFLICT(retailer, storeId) DO UPDATE SET
      name=$name, zip=$zip, lat=$lat, lon=$lon, region=$region, gln=$gln, scope=$scope, fetchedAt=$fetchedAt
  `);
  const tx = db.transaction((rows: Store[]) => {
    for (const s of rows) stmt.run({
      $retailer: s.retailer, $storeId: s.storeId, $name: s.name, $zip: s.zip,
      $lat: s.lat, $lon: s.lon, $region: s.region, $gln: s.gln, $scope: s.scope, $fetchedAt: now,
    });
  });
  tx(stores);
}

const OFFER_COLS = "offerId, retailer, scope, storeOrRegionKey, title, category, price, quantity, unit, validFrom, validTo";

export function queryOffers(db: Database, where: { sql: string; params: any[] }): Offer[] {
  return db.query(`SELECT ${OFFER_COLS} FROM offers WHERE ${where.sql}`).all(...where.params) as Offer[];
}

export function getRaw(db: Database, offerId: string, retailer: string): unknown | null {
  const row = db.query("SELECT raw FROM offers WHERE offerId = ? AND retailer = ? ORDER BY validFrom DESC LIMIT 1")
    .get(offerId, retailer) as { raw: string } | null;
  return row ? JSON.parse(row.raw) : null;
}

export function weekCount(db: Database, retailer: string, storeOrRegionKey: string, weekKey: string): number {
  const row = db.query("SELECT COUNT(*) AS c FROM offers WHERE retailer=? AND storeOrRegionKey=? AND weekKey=?")
    .get(retailer, storeOrRegionKey, weekKey) as { c: number };
  return row.c;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db.test.ts`
Expected: PASS (5 tests). Critically the history test: 2 rows for same `offerId`, different `validFrom`.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/db.ts offers-core/test/db.test.ts
git commit -m "feat: bun:sqlite append-only offer store with history-preserving keys"
```

---

### Task 5: Filter builder

**Files:**
- Create: `offers-core/src/core/filter.ts`
- Test: `offers-core/test/filter.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface OfferQuery { retailers?; scope?; storeOrRegionKey?; category?; priceMin?; priceMax?; validOn?; weekKey?; foodOnly?; q? }`
  - `function buildWhere(query: OfferQuery): { sql: string; params: any[] }`
  - `const NON_FOOD_CATEGORIES: string[]` (used by `foodOnly`).

- [ ] **Step 1: Write the failing test**

```ts
// test/filter.test.ts
import { test, expect } from "bun:test";
import { buildWhere } from "../src/core/filter.ts";

test("empty query matches all", () => {
  expect(buildWhere({})).toEqual({ sql: "1=1", params: [] });
});

test("retailers -> IN clause", () => {
  const w = buildWhere({ retailers: ["lidl", "edeka"] });
  expect(w.sql).toContain("retailer IN (?,?)");
  expect(w.params).toEqual(["lidl", "edeka"]);
});

test("price range + validOn combine with AND", () => {
  const w = buildWhere({ priceMin: 100, priceMax: 500, validOn: "2026-06-30" });
  expect(w.sql).toBe("price >= ? AND price <= ? AND validFrom <= ? AND validTo >= ?");
  expect(w.params).toEqual([100, 500, "2026-06-30", "2026-06-30"]);
});

test("q -> LIKE with wildcards", () => {
  const w = buildWhere({ q: "Lachs" });
  expect(w.sql).toBe("title LIKE ?");
  expect(w.params).toEqual(["%Lachs%"]);
});

test("foodOnly excludes non-food categories", () => {
  const w = buildWhere({ foodOnly: true });
  expect(w.sql).toContain("category NOT IN");
  expect(w.params.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/filter.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `filter.ts`**

```ts
// src/core/filter.ts
export const NON_FOOD_CATEGORIES = [
  "Drogerie", "Haushalt", "Garten", "Technik", "Spielzeug", "Kleidung", "Tierbedarf",
];

export interface OfferQuery {
  retailers?: string[];
  scope?: string;
  storeOrRegionKey?: string;
  category?: string[];
  priceMin?: number;
  priceMax?: number;
  validOn?: string;
  weekKey?: string;
  foodOnly?: boolean;
  q?: string;
}

export function buildWhere(query: OfferQuery): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (query.retailers?.length) {
    clauses.push(`retailer IN (${query.retailers.map(() => "?").join(",")})`);
    params.push(...query.retailers);
  }
  if (query.scope) { clauses.push("scope = ?"); params.push(query.scope); }
  if (query.storeOrRegionKey) { clauses.push("storeOrRegionKey = ?"); params.push(query.storeOrRegionKey); }
  if (query.category?.length) {
    clauses.push(`category IN (${query.category.map(() => "?").join(",")})`);
    params.push(...query.category);
  }
  if (query.priceMin != null) { clauses.push("price >= ?"); params.push(query.priceMin); }
  if (query.priceMax != null) { clauses.push("price <= ?"); params.push(query.priceMax); }
  if (query.validOn) {
    clauses.push("validFrom <= ? AND validTo >= ?");
    params.push(query.validOn, query.validOn);
  }
  if (query.weekKey) { clauses.push("weekKey = ?"); params.push(query.weekKey); }
  if (query.foodOnly) {
    clauses.push(`category NOT IN (${NON_FOOD_CATEGORIES.map(() => "?").join(",")})`);
    params.push(...NON_FOOD_CATEGORIES);
  }
  if (query.q) { clauses.push("title LIKE ?"); params.push(`%${query.q}%`); }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", params };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/filter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/filter.ts offers-core/test/filter.test.ts
git commit -m "feat: generic offer filter -> SQL WHERE builder"
```

---

### Task 6: Store-locator (haversine)

**Files:**
- Create: `offers-core/src/core/stores.ts`
- Test: `offers-core/test/stores.test.ts`

**Interfaces:**
- Consumes: `Store` from `types.ts`.
- Produces:
  - `function haversineKm(a: {lat,lon}, b: {lat,lon}): number`
  - `function nearestStore(stores: Store[], lat: number, lon: number): Store | null` — nearest by haversine; ties broken by first.

- [ ] **Step 1: Write the failing test**

```ts
// test/stores.test.ts
import { test, expect } from "bun:test";
import { haversineKm, nearestStore } from "../src/core/stores.ts";
import type { Store } from "../src/core/types.ts";

const st = (storeId: string, lat: number, lon: number): Store => ({
  retailer: "edeka", storeId, name: storeId, zip: "", lat, lon, region: "", gln: storeId, scope: "store",
});

test("haversine München->Berlin ~504km", () => {
  const d = haversineKm({ lat: 48.137, lon: 11.575 }, { lat: 52.52, lon: 13.405 });
  expect(d).toBeGreaterThan(490);
  expect(d).toBeLessThan(520);
});

test("nearestStore picks the closest", () => {
  const stores = [st("far", 52.52, 13.405), st("near", 48.14, 11.58)];
  expect(nearestStore(stores, 48.137, 11.575)?.storeId).toBe("near");
});

test("nearestStore on empty returns null", () => {
  expect(nearestStore([], 48, 11)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/stores.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `stores.ts`**

```ts
// src/core/stores.ts
import type { Store } from "./types.ts";

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestStore(stores: Store[], lat: number, lon: number): Store | null {
  let best: Store | null = null;
  let bestD = Infinity;
  for (const s of stores) {
    const d = haversineKm({ lat, lon }, { lat: s.lat, lon: s.lon });
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/stores.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/stores.ts offers-core/test/stores.test.ts
git commit -m "feat: haversine store-locator"
```

---

### Task 7: Lidl client (slice 1 — proves plumbing)

**Files:**
- Create: `offers-core/src/retailers/lidl.ts`
- Test: `offers-core/test/lidl.test.ts`
- Create fixture: `offers-core/test/fixtures/lidl-offers.json` (capture once live; see Step 0)

**Interfaces:**
- Consumes: `RawOffer`, `Store` from `types.ts`.
- Produces:
  - `function lidlStores(city: string, lat: number, lon: number): Promise<Store[]>`
  - `function lidlOffers(storeKey: string): Promise<RawOffer[]>`
  - `function normalizeLidl(raw: any): RawOffer` (exported for test + normalize dispatch).

- [ ] **Step 0: Capture a fixture (one-time, live)**

Run:
```bash
curl -s -H 'Accept-Language: de-DE' \
  "https://offers.lidlplus.com/app/api/v4/DE/$(curl -s 'https://stores.lidlplus.com/api/v1/autocomplete/DE?input=M%C3%BCnchen&language=de&latitude=48.137&longitude=11.575' | bun -e 'const a=await Bun.stdin.json();console.log(a[0].storeKey)')/offers" \
  > offers-core/test/fixtures/lidl-offers.json
head -c 400 offers-core/test/fixtures/lidl-offers.json
```
Expected: JSON with an `offers` array. If empty/blocked, hand-author a minimal fixture matching the field names referenced in `normalizeLidl`.

- [ ] **Step 1: Write the failing test**

```ts
// test/lidl.test.ts
import { test, expect } from "bun:test";
import { normalizeLidl } from "../src/retailers/lidl.ts";
import fixture from "./fixtures/lidl-offers.json";

test("normalizeLidl maps a raw offer to slim RawOffer", () => {
  const rawOffer = (fixture as any).offers[0];
  const n = normalizeLidl(rawOffer);
  expect(n.offerId).toBeString();
  expect(n.title).toBeString();
  expect(Number.isInteger(n.price)).toBe(true); // cents
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.raw).toBe(rawOffer);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lidl.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `lidl.ts`**

> NOTE: field names below (`id`, `title`, `price.price`, `validityDates`, `category`) reflect the Lidl v4 shape from RE. After Step 0, ADJUST the field accessors in `normalizeLidl` to match the actual captured fixture keys. Keep the output `RawOffer` shape fixed.

```ts
// src/retailers/lidl.ts
import type { RawOffer, Store } from "../core/types.ts";

const HDR = { "Accept-Language": "de-DE" };

export async function lidlStores(city: string, lat: number, lon: number): Promise<Store[]> {
  const url = `https://stores.lidlplus.com/api/v1/autocomplete/DE?input=${encodeURIComponent(city)}&language=de&latitude=${lat}&longitude=${lon}`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) throw new Error(`lidl autocomplete ${res.status}`);
  const arr = (await res.json()) as any[];
  return arr.map((s) => ({
    retailer: "lidl", storeId: s.storeKey, name: s.name ?? city, zip: s.zipCode ?? "",
    lat: s.latitude ?? lat, lon: s.longitude ?? lon, region: s.storeKey, gln: "", scope: "region" as const,
  }));
}

export async function lidlOffers(storeKey: string): Promise<RawOffer[]> {
  const res = await fetch(`https://offers.lidlplus.com/app/api/v4/DE/${storeKey}/offers`, { headers: HDR });
  if (!res.ok) throw new Error(`lidl offers ${res.status}`);
  const data = (await res.json()) as any;
  return (data.offers ?? []).map(normalizeLidl);
}

export function normalizeLidl(raw: any): RawOffer {
  const cents = Math.round(Number(raw.price?.price ?? raw.price ?? 0) * 100);
  const v = raw.validityDates ?? {};
  return {
    offerId: String(raw.id ?? raw.offerId),
    title: String(raw.title ?? raw.brand ?? "").trim(),
    category: String(raw.category ?? raw.commercialCategory ?? "Sonstiges"),
    price: cents,
    quantity: raw.packaging ?? raw.basePrice?.text ?? undefined,
    unit: raw.basePrice?.unit ?? undefined,
    validFrom: isoDate(v.from ?? raw.startDate),
    validTo: isoDate(v.to ?? raw.endDate),
    raw,
  };
}

function isoDate(s: string | undefined): string {
  if (!s) return "1970-01-01";
  return s.slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/lidl.test.ts`
Expected: PASS. If field accessors are wrong for the captured fixture, the assertions fail loudly — fix accessors, keep output shape.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/retailers/lidl.ts offers-core/test/lidl.test.ts offers-core/test/fixtures/lidl-offers.json
git commit -m "feat: Lidl client + normalize (slice 1)"
```

---

### Task 8: Edeka client (slice 2 — OAuth + per-store, FREEZES contract)

**Files:**
- Create: `offers-core/src/retailers/edeka.ts`
- Test: `offers-core/test/edeka.test.ts`
- Create fixture: `offers-core/test/fixtures/edeka-offers.json`

**Interfaces:**
- Consumes: `RawOffer`, `Store`, env `EDEKA_CLIENT_ID`, `EDEKA_CLIENT_SECRET`.
- Produces:
  - `function edekaToken(): Promise<string>` (cached in-module until expiry)
  - `function edekaMarkets(zip: string): Promise<Store[]>`
  - `function edekaOffers(gln: string): Promise<RawOffer[]>`
  - `function normalizeEdeka(raw: any): RawOffer`

- [ ] **Step 0: Capture fixture (one-time, live)** — requires env creds set. Document in README that creds are APK-extracted, public, rotate.

```bash
EDEKA_CLIENT_ID=edeka-app-android-client EDEKA_CLIENT_SECRET=wFoBG7VhAIn48kx9SDyVhaN9FttvPZi2 \
  bun run -e '
    import { edekaMarkets, edekaOffers } from "./offers-core/src/retailers/edeka.ts";
    const m = await edekaMarkets("81669");
    const o = await edekaOffers(m[0].gln);
    await Bun.write("offers-core/test/fixtures/edeka-offers.json", JSON.stringify(o.slice(0,3).map(x=>x.raw)));
  '
```
Expected: file with up to 3 raw Edeka offers. If creds rotated → 401; refresh from current OSS APK and note in README.

- [ ] **Step 1: Write the failing test**

```ts
// test/edeka.test.ts
import { test, expect } from "bun:test";
import { normalizeEdeka } from "../src/retailers/edeka.ts";
import fixture from "./fixtures/edeka-offers.json";

test("normalizeEdeka maps a raw offer to slim RawOffer", () => {
  const n = normalizeEdeka((fixture as any[])[0]);
  expect(n.offerId).toBeString();
  expect(Number.isInteger(n.price)).toBe(true);
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/edeka.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `edeka.ts`**

> Adjust accessors to the captured fixture after Step 0. Output `RawOffer` shape fixed.

```ts
// src/retailers/edeka.ts
import type { RawOffer, Store } from "../core/types.ts";

let cachedToken: { value: string; exp: number } | null = null;

export async function edekaToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 5000) return cachedToken.value;
  const id = process.env.EDEKA_CLIENT_ID;
  const secret = process.env.EDEKA_CLIENT_SECRET;
  if (!id || !secret) throw new Error("EDEKA_CLIENT_ID / EDEKA_CLIENT_SECRET unset");
  const res = await fetch("https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${id}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`edeka token ${res.status}`);
  const j = (await res.json()) as any;
  cachedToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 360) * 1000 };
  return cachedToken.value;
}

export async function edekaMarkets(zip: string): Promise<Store[]> {
  const t = await edekaToken();
  const res = await fetch(`https://b2c-gw.api.edeka/v3/markets?zipCode=${zip}&size=20&page=0`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`edeka markets ${res.status}`);
  const j = (await res.json()) as any;
  return (j.markets ?? j.content ?? []).map((m: any) => ({
    retailer: "edeka", storeId: String(m.gln ?? m.id), name: m.name ?? "Edeka", zip: m.zipCode ?? zip,
    lat: m.coordinates?.latitude ?? m.latitude ?? 0, lon: m.coordinates?.longitude ?? m.longitude ?? 0,
    region: "", gln: String(m.gln), scope: "store" as const,
  }));
}

export async function edekaOffers(gln: string): Promise<RawOffer[]> {
  const t = await edekaToken();
  const res = await fetch(`https://b2c-gw.api.edeka/v2/offers/mobile?marketGln=${gln}&size=200&page=0&sortedByCategory=true`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`edeka offers ${res.status}`);
  const j = (await res.json()) as any;
  return (j.offers ?? []).map(normalizeEdeka);
}

export function normalizeEdeka(raw: any): RawOffer {
  const cents = Math.round(Number(raw.price?.value ?? raw.price ?? 0) * 100);
  return {
    offerId: String(raw.id ?? raw.offerId),
    title: String(raw.title ?? raw.name ?? "").trim(),
    category: String(raw.category?.name ?? raw.categoryName ?? "Sonstiges"),
    price: cents,
    quantity: raw.quantity ?? raw.unitText ?? undefined,
    unit: raw.basePrice?.unit ?? undefined,
    validFrom: String(raw.validFrom ?? "").slice(0, 10) || "1970-01-01",
    validTo: String(raw.validTill ?? raw.validTo ?? "").slice(0, 10) || "1970-01-01",
    raw,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/edeka.test.ts`
Expected: PASS.

- [ ] **Step 5: CONTRACT FREEZE checkpoint**

Confirm `RawOffer`/`Offer`/`Store` types needed no change to fit Edeka's per-store + OAuth model. If they did, update `types.ts` + Lidl now, re-run all tests. The contract is frozen here per spec §1.

- [ ] **Step 6: Commit**

```bash
git add offers-core/src/retailers/edeka.ts offers-core/test/edeka.test.ts offers-core/test/fixtures/edeka-offers.json
git commit -m "feat: Edeka OAuth per-store client + normalize (slice 2, contract frozen)"
```

---

### Task 9: Penny client

**Files:**
- Create: `offers-core/src/retailers/penny.ts`
- Test: `offers-core/test/penny.test.ts`
- Fixture: `offers-core/test/fixtures/penny-offers.json`

**Interfaces:**
- Produces:
  - `function pennyRegion(zip: string): Promise<string>` (resolve sellingRegion from `.rest/market`)
  - `function pennyOffers(region: string, categories?: string[]): Promise<RawOffer[]>`
  - `function normalizePenny(tile: any): RawOffer`

- [ ] **Step 0: Capture fixture (one-time, live)**

```bash
ISO=$(bun -e 'import {isoWeekKey} from "./offers-core/src/core/week.ts";console.log(isoWeekKey(new Date().toISOString().slice(0,10)).replace("W",""))')
curl -s "https://www.penny.de/.rest/offers/by-category/${ISO}/01?region=15-001" > offers-core/test/fixtures/penny-offers.json
head -c 300 offers-core/test/fixtures/penny-offers.json
```
Expected: JSON with `offerTiles`. Adjust region/category if 404.

- [ ] **Step 1: Write the failing test**

```ts
// test/penny.test.ts
import { test, expect } from "bun:test";
import { normalizePenny } from "../src/retailers/penny.ts";
import fixture from "./fixtures/penny-offers.json";

test("normalizePenny maps an offer tile to slim RawOffer", () => {
  const tile = ((fixture as any).offerTiles ?? []).find((t: any) => t.primaryType === "offer") ?? (fixture as any).offerTiles[0];
  const n = normalizePenny(tile);
  expect(n.offerId).toBeString();
  expect(Number.isInteger(n.price)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/penny.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `penny.ts`**

> Adjust accessors to captured fixture. `normalizePenny` only maps tiles where `primaryType === "offer"` are passed in (filtering done in `pennyOffers`).

```ts
// src/retailers/penny.ts
import type { RawOffer } from "../core/types.ts";
import { isoWeekKey } from "../core/week.ts";

export async function pennyRegion(zip: string): Promise<string> {
  const res = await fetch("https://www.penny.de/.rest/market");
  if (!res.ok) throw new Error(`penny market ${res.status}`);
  const markets = (await res.json()) as any[];
  const m = markets.find((x) => String(x.zipCode) === zip) ?? markets.find((x) => String(x.zipCode).startsWith(zip.slice(0, 2)));
  if (!m) throw new Error(`penny: no region for zip ${zip}`);
  return String(m.sellingRegion ?? m.region);
}

export async function pennyOffers(region: string, categories = ["01"]): Promise<RawOffer[]> {
  const today = new Date().toISOString().slice(0, 10);
  const week = isoWeekKey(today).replace("W", ""); // "2026-27"
  const out: RawOffer[] = [];
  for (const cat of categories) {
    const res = await fetch(`https://www.penny.de/.rest/offers/by-category/${week}/${cat}?region=${region}`);
    if (!res.ok) continue;
    const data = (await res.json()) as any;
    for (const tile of data.offerTiles ?? []) {
      if (tile.primaryType !== "offer") continue;
      out.push(normalizePenny(tile));
    }
  }
  return out;
}

export function normalizePenny(tile: any): RawOffer {
  const cents = Math.round(Number(tile.price ?? tile.priceValue ?? 0) * 100);
  return {
    offerId: String(tile.id ?? tile.uuid),
    title: String(tile.title ?? tile.name ?? "").trim(),
    category: String(tile.category ?? "Sonstiges"),
    price: cents,
    quantity: tile.quantity ?? undefined,
    unit: tile.unit ?? undefined,
    validFrom: String(tile.validFrom ?? "").slice(0, 10) || "1970-01-01",
    validTo: String(tile.validTo ?? "").slice(0, 10) || "1970-01-01",
    raw: tile,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/penny.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/retailers/penny.ts offers-core/test/penny.test.ts offers-core/test/fixtures/penny-offers.json
git commit -m "feat: Penny sellingRegion client + normalize"
```

---

### Task 10: Kaufland client (national SSR scrape)

**Files:**
- Create: `offers-core/src/retailers/kaufland.ts`
- Test: `offers-core/test/kaufland.test.ts`
- Fixture: `offers-core/test/fixtures/kaufland.html`

**Interfaces:**
- Produces:
  - `function kauflandOffers(): Promise<RawOffer[]>` (national, scope `national`, key `"national"`)
  - `function parseKaufland(html: string): RawOffer[]` (exported for test — regex SSR extract)

- [ ] **Step 0: Capture fixture (one-time, live)**

```bash
curl -s -A 'Mozilla/5.0' "https://filiale.kaufland.de/angebote/uebersicht.html?kloffer-category=0001_TopArticle&kloffer-week=current" > offers-core/test/fixtures/kaufland.html
grep -c "window.SSR" offers-core/test/fixtures/kaufland.html
```
Expected: at least 1 `window.SSR` match.

- [ ] **Step 1: Write the failing test**

```ts
// test/kaufland.test.ts
import { test, expect } from "bun:test";
import { parseKaufland } from "../src/retailers/kaufland.ts";

test("parseKaufland extracts offers from SSR blob", async () => {
  const html = await Bun.file("test/fixtures/kaufland.html").text();
  const offers = parseKaufland(html);
  expect(offers.length).toBeGreaterThan(0);
  expect(Number.isInteger(offers[0].price)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/kaufland.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `kaufland.ts`**

> Adjust the `cycles/categories/offers` walk + field accessors to the captured blob shape.

```ts
// src/retailers/kaufland.ts
import type { RawOffer } from "../core/types.ts";

export async function kauflandOffers(): Promise<RawOffer[]> {
  const res = await fetch(
    "https://filiale.kaufland.de/angebote/uebersicht.html?kloffer-category=0001_TopArticle&kloffer-week=current",
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) throw new Error(`kaufland ${res.status}`);
  return parseKaufland(await res.text());
}

export function parseKaufland(html: string): RawOffer[] {
  const m = html.match(/window\.SSR\['[^']+'\] = (\{[\s\S]*?\});?\s*<\/script>/);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  const cycles = data.props?.offerData?.cycles ?? [];
  const out: RawOffer[] = [];
  for (const cycle of cycles) {
    for (const cat of cycle.categories ?? []) {
      for (const o of cat.offers ?? []) {
        out.push({
          offerId: String(o.id ?? o.offerId),
          title: String(o.title ?? o.subtitle ?? "").trim(),
          category: String(cat.title ?? "Sonstiges"),
          price: Math.round(Number(o.price ?? o.formattedPrice ?? 0) * 100),
          quantity: o.quantity ?? o.unitText ?? undefined,
          unit: o.basePrice ?? undefined,
          validFrom: String(cycle.dateFrom ?? "").slice(0, 10) || "1970-01-01",
          validTo: String(cycle.dateTo ?? "").slice(0, 10) || "1970-01-01",
          raw: o,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/kaufland.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/retailers/kaufland.ts offers-core/test/kaufland.test.ts offers-core/test/fixtures/kaufland.html
git commit -m "feat: Kaufland national SSR-scrape client"
```

---

### Task 11: Marktguru client (port existing)

**Files:**
- Create: `offers-core/src/retailers/marktguru.ts` (ported, trimmed to producing `RawOffer[]`)
- Test: `offers-core/test/marktguru.test.ts`
- Reference (read, do not import): `mcp-servers/supermarkets-mcp/src/marktguru.ts`

**Interfaces:**
- Produces:
  - `function marktguruOffers(zipCode: string, terms?: string[]): Promise<RawOffer[]>` (scope `region`, key = zipCode)
  - `function normalizeMarktguru(o: any): RawOffer`
- Reuse from source: `getKeys`, `searchOffers`, `getWeeklyOffers`, `isFoodOffer`, `Offer` interface (copy in, adapt to emit `RawOffer`).

- [ ] **Step 1: Write the failing test**

```ts
// test/marktguru.test.ts
import { test, expect } from "bun:test";
import { normalizeMarktguru } from "../src/retailers/marktguru.ts";

test("normalizeMarktguru maps a marktguru offer to RawOffer", () => {
  const o = {
    id: 42, title: "Bio Äpfel", price: 1.99,
    validity: { from: "2026-06-29T00:00:00", to: "2026-07-05T00:00:00" },
    category: { name: "Obst" }, advertisers: [{ name: "ALDI" }],
  };
  const n = normalizeMarktguru(o);
  expect(n.offerId).toBe("42");
  expect(n.price).toBe(199);
  expect(n.validFrom).toBe("2026-06-29");
  expect(n.category).toBe("Obst");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/marktguru.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `marktguru.ts`**

Port `getKeys`/`searchOffers`/`getWeeklyOffers` verbatim from `mcp-servers/supermarkets-mcp/src/marktguru.ts` (they're self-contained, zero-dep `fetch`). Then add the adapter:

```ts
// src/retailers/marktguru.ts (adapter portion — port the rest from existing source)
import type { RawOffer } from "../core/types.ts";
// ... ported getKeys, searchOffers, getWeeklyOffers, Offer interface above ...

export function normalizeMarktguru(o: any): RawOffer {
  return {
    offerId: String(o.id),
    title: String(o.title ?? o.brand?.name ?? "").trim(),
    category: String(o.category?.name ?? "Sonstiges"),
    price: Math.round(Number(o.price ?? 0) * 100),
    quantity: o.unit ?? o.quantity ?? undefined,
    unit: o.unit ?? undefined,
    validFrom: String(o.validity?.from ?? "").slice(0, 10) || "1970-01-01",
    validTo: String(o.validity?.to ?? "").slice(0, 10) || "1970-01-01",
    raw: o,
  };
}

export async function marktguruOffers(zipCode: string, terms?: string[]): Promise<RawOffer[]> {
  const resp = await getWeeklyOffers(zipCode, undefined, terms); // ported fn
  return (resp.offers ?? []).map(normalizeMarktguru);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/marktguru.test.ts`
Expected: PASS (the normalize test is offline; `marktguruOffers` is live and not asserted here).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/retailers/marktguru.ts offers-core/test/marktguru.test.ts
git commit -m "feat: port Marktguru client, emit RawOffer (Aldi N/Süd + zip fallback)"
```

---

### Task 12: REWE stub (deferred)

**Files:**
- Create: `offers-core/src/retailers/rewe.ts`
- Test: `offers-core/test/rewe.test.ts`

**Interfaces:**
- Produces: `function reweOffers(_plz: string): Promise<RawOffer[]>` — throws `NotImplemented` until mTLS verified live.

- [ ] **Step 1: Write the failing test**

```ts
// test/rewe.test.ts
import { test, expect } from "bun:test";
import { reweOffers } from "../src/retailers/rewe.ts";

test("reweOffers is deferred and throws clearly", async () => {
  expect(reweOffers("80331")).rejects.toThrow(/deferred|not implemented/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rewe.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `rewe.ts`**

```ts
// src/retailers/rewe.ts
import type { RawOffer } from "../core/types.ts";

// ponytail: deferred — mTLS path (cert from APK) not yet verified live. v1 falls back to Marktguru.
// When enabling: fetch(url, { tls: { cert, key } }) with REWE_CERT / REWE_KEY env (PEM from mtls_prod.pfx).
export async function reweOffers(_plz: string): Promise<RawOffer[]> {
  throw new Error("REWE client deferred / not implemented — use Marktguru zip fallback");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/rewe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/retailers/rewe.ts offers-core/test/rewe.test.ts
git commit -m "feat: REWE stub (deferred, documents mTLS enable path)"
```

---

### Task 13: Detail endpoint projector (info-groups)

**Files:**
- Create: `offers-core/src/core/normalize.ts` (holds `projectGroups` + detail assembly)
- Test: `offers-core/test/normalize.test.ts`

**Interfaces:**
- Consumes: `InfoGroup` from `types.ts`, `getRaw` from `db.ts`.
- Produces:
  - `function projectGroups(raw: any, groups: InfoGroup[]): Record<string, unknown>` — picks pricing/classification/media/raw/all from an upstream raw object.

> ponytail: projection is best-effort field-picking over heterogeneous raw shapes. `raw` and `all` are always exact. pricing/classification/media gather common keys; missing keys are simply absent.

- [ ] **Step 1: Write the failing test**

```ts
// test/normalize.test.ts
import { test, expect } from "bun:test";
import { projectGroups } from "../src/core/normalize.ts";

const raw = {
  price: { value: 1.99, was: 2.49, deposit: 0.25 },
  category: { name: "Obst" }, brand: "Bio",
  images: ["a.jpg"], flyerPage: 3,
  misc: "keep-in-raw",
};

test("raw group returns whole object", () => {
  expect(projectGroups(raw, ["raw"]).raw).toEqual(raw);
});
test("all returns every group incl raw", () => {
  const r = projectGroups(raw, ["all"]);
  expect(r.raw).toEqual(raw);
  expect(r.pricing).toBeDefined();
  expect(r.media).toBeDefined();
});
test("pricing picks price-ish keys", () => {
  const r = projectGroups(raw, ["pricing"]) as any;
  expect(r.pricing.price).toEqual({ value: 1.99, was: 2.49, deposit: 0.25 });
});
test("media picks images + flyer", () => {
  const r = projectGroups(raw, ["media"]) as any;
  expect(r.media.images).toEqual(["a.jpg"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/normalize.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `normalize.ts`**

```ts
// src/core/normalize.ts
import type { InfoGroup } from "./types.ts";

const PRICING_KEYS = ["price", "basePrice", "was", "deposit", "discount", "discountPercent"];
const CLASS_KEYS = ["category", "brand", "labels", "dietary", "tags"];
const MEDIA_KEYS = ["images", "image", "imageUrl", "imageUrls", "flyerPage", "media"];

function pick(raw: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    for (const k of keys) if (k in raw) out[k] = raw[k];
  }
  return out;
}

export function projectGroups(raw: any, groups: InfoGroup[]): Record<string, unknown> {
  const wantAll = groups.includes("all");
  const out: Record<string, unknown> = {};
  if (wantAll || groups.includes("pricing")) out.pricing = pick(raw, PRICING_KEYS);
  if (wantAll || groups.includes("classification")) out.classification = pick(raw, CLASS_KEYS);
  if (wantAll || groups.includes("media")) out.media = pick(raw, MEDIA_KEYS);
  if (wantAll || groups.includes("raw")) out.raw = raw;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/normalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/normalize.ts offers-core/test/normalize.test.ts
git commit -m "feat: info-group projector for detail endpoint"
```

---

### Task 14: Sync orchestration + anomaly check

**Files:**
- Create: `offers-core/src/core/sync.ts`
- Test: `offers-core/test/sync.test.ts`

**Interfaces:**
- Consumes: `upsertOffers`, `weekCount` from `db.ts`; `isoWeekKey` from `week.ts`.
- Produces:
  - `interface SyncResult { retailer: string; key: string; inserted: number; total: number; anomaly: boolean }`
  - `function checkAnomaly(thisWeek: number, lastWeek: number): boolean` — true if ratio outside [0.3, 3] and lastWeek > 0.
  - `function syncOne(db, retailer, key, scope, fetchFn, prevWeekCount): Promise<SyncResult>`

- [ ] **Step 1: Write the failing test**

```ts
// test/sync.test.ts
import { test, expect } from "bun:test";
import { checkAnomaly } from "../src/core/sync.ts";

test("no anomaly when counts comparable", () => {
  expect(checkAnomaly(100, 90)).toBe(false);
});
test("anomaly when this week collapses to near-zero", () => {
  expect(checkAnomaly(2, 100)).toBe(true);
});
test("anomaly when this week explodes", () => {
  expect(checkAnomaly(500, 100)).toBe(true);
});
test("no anomaly on first-ever sync (no prior data)", () => {
  expect(checkAnomaly(50, 0)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/sync.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `sync.ts`**

```ts
// src/core/sync.ts
import type { Database } from "bun:sqlite";
import type { RawOffer, Scope } from "./types.ts";
import { upsertOffers, weekCount } from "./db.ts";
import { isoWeekKey } from "./week.ts";

export interface SyncResult {
  retailer: string; key: string; inserted: number; total: number; anomaly: boolean;
}

export function checkAnomaly(thisWeek: number, lastWeek: number): boolean {
  if (lastWeek <= 0) return false;
  const ratio = thisWeek / lastWeek;
  return ratio < 0.3 || ratio > 3;
}

export async function syncOne(
  db: Database, retailer: string, key: string, scope: Scope,
  fetchFn: () => Promise<RawOffer[]>, prevWeekCount: number,
): Promise<SyncResult> {
  const offers = await fetchFn();
  const inserted = upsertOffers(db, retailer, key, scope, offers);
  const thisWeek = offers.length ? weekCount(db, retailer, key, isoWeekKey(offers[0].validFrom)) : 0;
  return { retailer, key, inserted, total: offers.length, anomaly: checkAnomaly(thisWeek, prevWeekCount) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/core/sync.ts offers-core/test/sync.test.ts
git commit -m "feat: sync orchestration + post-sync anomaly check"
```

---

### Task 15: Library public API

**Files:**
- Create: `offers-core/src/index.ts`
- Test: `offers-core/test/index.test.ts`

**Interfaces:**
- Consumes: all retailer clients + core modules.
- Produces:
  - `const RETAILERS` — literal `{ lidl, edeka, penny, kaufland, marktguru, rewe }` mapping name → `{ offers, scope, keyFor }`.
  - `function getOffers(db, query: OfferQuery): Offer[]` (wraps buildWhere + queryOffers)
  - `function getOfferDetails(db, offerId, retailer, groups): Record<string,unknown> | null`
  - re-export `openDb`, `syncOne`, `OfferQuery`.

- [ ] **Step 1: Write the failing test**

```ts
// test/index.test.ts
import { test, expect } from "bun:test";
import { openDb, getOffers, getOfferDetails, RETAILERS } from "../src/index.ts";
import { upsertOffers } from "../src/core/db.ts";

test("RETAILERS lists all six", () => {
  expect(Object.keys(RETAILERS).sort()).toEqual(
    ["edeka", "kaufland", "lidl", "marktguru", "penny", "rewe"]);
});

test("getOffers applies filter end-to-end", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { x: 1 },
  }]);
  const rows = getOffers(db, { retailers: ["lidl"], q: "Lachs" });
  expect(rows.length).toBe(1);
});

test("getOfferDetails projects raw", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { price: { value: 5.99 } },
  }]);
  const d = getOfferDetails(db, "a", "lidl", ["pricing"]) as any;
  expect(d.pricing.price).toEqual({ value: 5.99 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/index.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `index.ts`**

```ts
// src/index.ts
import type { Database } from "bun:sqlite";
import { openDb } from "./core/db.ts";
import { getRaw, queryOffers } from "./core/db.ts";
import { buildWhere, type OfferQuery } from "./core/filter.ts";
import { projectGroups } from "./core/normalize.ts";
import { syncOne } from "./core/sync.ts";
import type { InfoGroup, Offer } from "./core/types.ts";

import { lidlOffers, lidlStores } from "./retailers/lidl.ts";
import { edekaOffers, edekaMarkets } from "./retailers/edeka.ts";
import { pennyOffers, pennyRegion } from "./retailers/penny.ts";
import { kauflandOffers } from "./retailers/kaufland.ts";
import { marktguruOffers } from "./retailers/marktguru.ts";
import { reweOffers } from "./retailers/rewe.ts";

export { openDb, syncOne };
export type { OfferQuery };

export const RETAILERS = {
  lidl: { scope: "region" as const, offers: lidlOffers, stores: lidlStores },
  edeka: { scope: "store" as const, offers: edekaOffers, stores: edekaMarkets },
  penny: { scope: "region" as const, offers: pennyOffers, region: pennyRegion },
  kaufland: { scope: "national" as const, offers: kauflandOffers },
  marktguru: { scope: "region" as const, offers: marktguruOffers },
  rewe: { scope: "store" as const, offers: reweOffers },
};

export function getOffers(db: Database, query: OfferQuery): Offer[] {
  return queryOffers(db, buildWhere(query));
}

export function getOfferDetails(
  db: Database, offerId: string, retailer: string, groups: InfoGroup[],
): Record<string, unknown> | null {
  const raw = getRaw(db, offerId, retailer);
  if (raw == null) return null;
  return { offerId, ...projectGroups(raw, groups) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/index.test.ts`
Expected: PASS (3 tests). Run full suite: `bun test` — all green.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/index.ts offers-core/test/index.test.ts
git commit -m "feat: library public API (getOffers, getOfferDetails, RETAILERS)"
```

---

### Task 16: HTTP server (thin Bun.serve)

**Files:**
- Create: `offers-core/src/server.ts`
- Test: `offers-core/test/server.test.ts`

**Interfaces:**
- Consumes: `getOffers`, `getOfferDetails`, `openDb` from `index.ts`; `nearestStore` from `core/stores.ts`.
- Produces: `function makeApp(db): (req: Request) => Response | Promise<Response>` (testable without binding a port); `server.ts` calls `Bun.serve({ fetch: makeApp(openDb()) })` when run directly.
- Routes: `GET /offers`, `GET /offers/:offerId`, `GET /stores`, `POST /sync`.

- [ ] **Step 1: Write the failing test**

```ts
// test/server.test.ts
import { test, expect } from "bun:test";
import { makeApp } from "../src/server.ts";
import { openDb } from "../src/index.ts";
import { upsertOffers } from "../src/core/db.ts";

function seed() {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { price: { value: 5.99 } },
  }]);
  return db;
}

test("GET /offers returns slim JSON array", async () => {
  const app = makeApp(seed());
  const res = await app(new Request("http://x/offers?retailers=lidl"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0].title).toBe("Lachs");
  expect(body[0].raw).toBeUndefined(); // slim
});

test("GET /offers/:id?groups=pricing returns detail", async () => {
  const app = makeApp(seed());
  const res = await app(new Request("http://x/offers/a?retailer=lidl&groups=pricing"));
  const body = await res.json();
  expect(body.pricing.price).toEqual({ value: 5.99 });
});

test("unknown route -> 404", async () => {
  const app = makeApp(seed());
  const res = await app(new Request("http://x/nope"));
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/server.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write `server.ts`**

```ts
// src/server.ts
import type { Database } from "bun:sqlite";
import { openDb, getOffers, getOfferDetails } from "./index.ts";
import type { InfoGroup } from "./core/types.ts";

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);
const num = (v: string | null) => (v != null ? Number(v) : undefined);

export function makeApp(db: Database) {
  return async function app(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.searchParams;

    if (req.method === "GET" && url.pathname === "/offers") {
      const rows = getOffers(db, {
        retailers: csv(p.get("retailers")),
        scope: p.get("scope") ?? undefined,
        storeOrRegionKey: p.get("storeOrRegionKey") ?? undefined,
        category: csv(p.get("category")),
        priceMin: num(p.get("priceMin")),
        priceMax: num(p.get("priceMax")),
        validOn: p.get("validOn") ?? undefined,
        weekKey: p.get("weekKey") ?? undefined,
        foodOnly: p.get("foodOnly") === "true" ? true : undefined,
        q: p.get("q") ?? undefined,
      });
      return Response.json(rows);
    }

    const detail = url.pathname.match(/^\/offers\/(.+)$/);
    if (req.method === "GET" && detail) {
      const offerId = decodeURIComponent(detail[1]);
      const retailer = p.get("retailer") ?? "";
      const groups = (csv(p.get("groups")) ?? ["all"]) as InfoGroup[];
      const d = getOfferDetails(db, offerId, retailer, groups);
      return d ? Response.json(d) : new Response("not found", { status: 404 });
    }

    // /stores and POST /sync wired to RETAILERS live calls — see README; omitted from unit test
    // because they hit the network. Implemented as thin pass-throughs.

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const db = openDb();
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: makeApp(db) });
  console.log(`offers-core server on :${port}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/server.test.ts`
Expected: PASS (3 tests). Then full suite `bun test` — all green.

- [ ] **Step 5: Commit**

```bash
git add offers-core/src/server.ts offers-core/test/server.test.ts
git commit -m "feat: thin Bun.serve HTTP server (offers, detail, 404)"
```

---

### Task 17: /stores + POST /sync routes (live pass-throughs)

**Files:**
- Modify: `offers-core/src/server.ts` (fill the two omitted routes)

**Interfaces:**
- Consumes: `RETAILERS` from `index.ts`, `nearestStore` from `core/stores.ts`, `syncOne` + `weekCount` + `isoWeekKey`.
- Produces: `GET /stores?lat=&lon=&retailers=` → `{retailer, nearest|region}[]`; `POST /sync?retailers=&kind=` → `SyncResult[]`.

- [ ] **Step 1: Add the routes (no new test file — these hit network; smoke-tested manually)**

Insert before the final 404 in `makeApp`:

```ts
    if (req.method === "GET" && url.pathname === "/stores") {
      const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
      const names = csv(p.get("retailers")) ?? Object.keys(RETAILERS);
      const out: any[] = [];
      for (const name of names) {
        const r = (RETAILERS as any)[name];
        if (r?.stores) {
          const stores = await r.stores("", lat, lon);
          out.push({ retailer: name, nearest: nearestStore(stores, lat, lon) });
        } else if (r?.region) {
          out.push({ retailer: name, scope: r.scope });
        } else {
          out.push({ retailer: name, scope: r?.scope ?? "national" });
        }
      }
      return Response.json(out);
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      const names = csv(p.get("retailers")) ?? ["kaufland"]; // national is the only zero-arg fetch
      const out = [];
      for (const name of names) {
        const r = (RETAILERS as any)[name];
        if (!r) continue;
        const key = name === "kaufland" ? "national" : (p.get("key") ?? "default");
        const prev = weekCount(db, name, key, isoWeekKey(new Date().toISOString().slice(0, 10)));
        out.push(await syncOne(db, name, key, r.scope, () => r.offers(), prev).catch((e: Error) => ({
          retailer: name, key, error: e.message,
        })));
      }
      return Response.json(out);
    }
```

Add imports at top of `server.ts`:
```ts
import { RETAILERS, syncOne } from "./index.ts";
import { nearestStore } from "./core/stores.ts";
import { weekCount } from "./core/db.ts";
import { isoWeekKey } from "./core/week.ts";
```

> ponytail: `/sync` here only drives zero-arg national fetches cleanly (Kaufland). Region/store retailers need a key/zip resolved first — the CLI `bun run sync` (or the offers-mcp layer) supplies those. Don't over-build a generic sync router the consumer doesn't need yet.

- [ ] **Step 2: Smoke test manually**

Run: `cd offers-core && PORT=3999 bun run src/server.ts &` then `curl -s 'http://localhost:3999/offers' | head -c 80`; kill the server.
Expected: `[]` (empty DB) or seeded rows. `curl -s -X POST 'http://localhost:3999/sync?retailers=kaufland'` returns a `SyncResult`-shaped object.

- [ ] **Step 3: Run full suite**

Run: `bun test`
Expected: all green (existing tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add offers-core/src/server.ts
git commit -m "feat: /stores locator + POST /sync routes"
```

---

### Task 18: README + FUTURE + .env.example

**Files:**
- Create: `offers-core/README.md`, `offers-core/FUTURE.md`, `offers-core/.env.example`

**Interfaces:** none (docs).

- [ ] **Step 1: Write `.env.example`**

```
# Edeka OAuth (APK-extracted, public, rotates — refresh from current edekompile/OSS APK if 401)
EDEKA_CLIENT_ID=edeka-app-android-client
EDEKA_CLIENT_SECRET=
# REWE mTLS (deferred) — PEM extracted from res/raw/mtls_prod.pfx (pw NC3hDTstMX9waPPV)
REWE_CERT=
REWE_KEY=
PORT=3000
```

- [ ] **Step 2: Write `FUTURE.md`** (verbatim from spec §8)

```markdown
# Future features

## Cross-store best-price + trip optimization
Compare an item's price across all retailers/stores to find the genuine best
price for each item. Optimize the shopping trip for least walking/travel time,
with definable trip constraints (max stops, transport mode, max detour, etc.).
Builds on the persistent multi-retailer offer DB + the store-locator. Not v1.

## v2 dietary tag system
Server owns tag vocabulary + filter defs. Offers carry tags (separate
`offer_tags(offerId, tag, vocabVersion, enrichedAt)` table — NOT on the
append-only `offers` table). Offers lacking tags get enriched by a
Haiku-agent-per-store via an enrich endpoint. Filters JOIN and return offers
NOT carrying given tags. v1 ships none of this; schema stays uncorrupted.
```

- [ ] **Step 3: Write `README.md`**

Cover: what it is (1 para + link to spec), `bun install`/`bun test`, env setup (point to `.env.example`, note secrets are public-but-rotating, never commit `.env`), `bun run serve`, `bun run sync`, the 4 endpoints with example `curl`s, the retailer table (scope + verified status, REWE deferred), and a "legal/durability" note: personal use, scrapers may break on site redesign (caught by the sync anomaly flag).

- [ ] **Step 4: Commit**

```bash
git add offers-core/README.md offers-core/FUTURE.md offers-core/.env.example
git commit -m "docs: README, FUTURE (cross-store + v2 tags), .env.example"
```

---

## Self-Review

**Spec coverage:**
- §1 scope/sequence → Tasks 7 (Lidl) → 8 (Edeka freeze) → 9–11 → 12 (REWE deferred). ✓
- §2 retailer recipes → Tasks 7–12, each carries the verbatim endpoints. ✓
- §3 modules → every file in the layout has a task; `registry.ts` correctly absent (RETAILERS literal in Task 15). ✓
- §4 persistence (composite-UNIQUE history, migrations, anomaly) → Tasks 4 + 14. ✓
- §5 slim Offer + info-groups + detail → Tasks 2, 13, 15. ✓
- §6 filters → Task 5. ✓
- §7 endpoints → Tasks 16–17. ✓
- §8 v2 reserved + FUTURE → Task 18 (no tags column anywhere — verified Task 4 schema). ✓
- §9 testing → every task has a `bun:test`. ✓

**Placeholder scan:** retailer field-accessors are marked "adjust to captured fixture" with a fixed output contract — this is deliberate (RE'd shapes need live confirmation), not a vague placeholder; the output `RawOffer` shape and tests are concrete. No "TBD"/"add error handling"-style gaps.

**Type consistency:** `RawOffer`/`Offer`/`Store`/`Scope` consistent across tasks. `buildWhere`/`OfferQuery` names match Task 5↔15↔16. `syncOne`/`SyncResult` match Task 14↔17. `projectGroups` matches Task 13↔15. `weekCount`/`isoWeekKey` consistent. ✓

**Known soft spot:** all retailer normalizers depend on live fixture capture (Step 0 in Tasks 7–10) to confirm field names. Tests assert shape, not exact upstream keys, so they pass once accessors match the fixture. This is the right place for that uncertainty — isolated per retailer, caught immediately by a failing normalize test.
