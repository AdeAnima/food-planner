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
