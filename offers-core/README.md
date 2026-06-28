# offers-core

A persistent, multi-retailer German supermarket offer library + thin HTTP server.
Fetches weekly offers from several retailers, stores them append-only in SQLite,
and serves slim JSON for downstream consumers (offers-mcp, the food-planner).

Design spec: [`docs/superpowers/specs/2026-06-26-offers-core-design.md`](../docs/superpowers/specs/2026-06-26-offers-core-design.md).

## Stack

bun + TypeScript, zero third-party runtime deps (node builtins + `bun:sqlite` only).

## Install & test

```bash
bun install
bun test
```

## Environment

Copy `.env.example` → `.env` and fill in the secrets. The Edeka OAuth creds and
REWE mTLS cert are **APK-extracted (public, but rotating)** — refresh them from a
current OSS APK dump if a retailer starts returning 401. **Never commit `.env`.**

```bash
cp .env.example .env
```

## Run the server

```bash
bun run serve          # listens on :$PORT (default 3000)
```

## One-shot sync (cron-friendly)

```bash
bun run sync           # syncs kaufland into the DB, prints SyncResult JSON
bun run sync kaufland  # same, explicit
```

**Kaufland-only in v1.** Only `kauflandOffers()` is zero-arg; the other retailers
need a resolved store key/zip first (the offers-mcp layer's job). `bun run sync lidl`
returns `{"error":"needs key resolution (offers-mcp layer)"}` rather than firing a
broken fetch. See [`FUTURE.md`](FUTURE.md) for keyed multi-retailer sync.

## Endpoints

All return JSON. Start the server first (`bun run serve`).

### `GET /offers` — slim offer list

Query params (all optional): `retailers`, `scope`, `storeOrRegionKey`, `category`,
`priceMin`, `priceMax`, `validOn`, `weekKey`, `foodOnly`, `q`. CSV params
(`retailers`, `category`) take comma-separated values. Defaults to offers valid
today unless `validOn` or `weekKey` is pinned.

```bash
curl 'http://localhost:3000/offers?retailers=lidl,kaufland&priceMax=500&foodOnly=true'
```

### `GET /offers/:offerId` — offer detail

Needs the full composite key (offerId is not unique on its own): `retailer`,
`storeOrRegionKey`, `validFrom`. Optional `groups` (CSV) selects info groups —
`pricing`, `classification`, `media`, `raw`, `all` (default `all`). 404 on a
wrong composite key.

```bash
curl 'http://localhost:3000/offers/a?retailer=lidl&storeOrRegionKey=DE-BW&validFrom=2026-06-29&groups=pricing'
```

### `GET /stores` — nearest-store locator

`lat` + `lon` + `retailers` (CSV, default all). Only **lidl** has a geo store
lookup; others return their scope only (edeka is zip-keyed, penny is region-scoped).

```bash
curl 'http://localhost:3000/stores?retailers=lidl&lat=52.5&lon=13.4'
```

### `POST /sync` — trigger a sync

Kaufland-only, same as `bun run sync` (see above). `retailers` CSV, default kaufland.

```bash
curl -X POST 'http://localhost:3000/sync?retailers=kaufland'
```

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

## Retailers

| Retailer  | Scope    | Status                                  |
|-----------|----------|-----------------------------------------|
| Kaufland  | national | ✅ verified (zero-arg, CLI-syncable)    |
| Lidl      | region   | ✅ verified (geo store lookup)          |
| Edeka     | store    | ✅ verified (zip-keyed, OAuth)          |
| Penny     | region   | ✅ verified                             |
| Marktguru | region   | ✅ verified (zip + search terms)        |
| REWE      | store    | ⏸️ deferred (mTLS, not wired into sync) |

## Legal & durability

Personal use. The retailer fetchers scrape/consume undocumented endpoints and
**may break on a site or API redesign** — the weekly sync flags a likely break via
an anomaly check (offer count drops below 30% or jumps above 300% of the prior
week). The `offers` table is append-only: a bad sync adds rows, it never corrupts
or overwrites prior weeks.
