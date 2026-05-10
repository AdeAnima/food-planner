# supermarkets-mcp (Bun/TS)

MCP server exposing Marktguru.de weekly supermarket offers for German ZIP codes / addresses.

## Tools

- `list_stores(zipCode?)` — discover retailer slugs available for a ZIP. Probes live `filters.retailers` facet, falls back to hardcoded list.
- `search_offers(query, zipCode, stores?, limit?)` — keyword search current offers.
- `get_weekly_offers(zipCode, stores?, terms?, perTermLimit?)` — fan-out parallel search over a basket of food terms (default = pescetarian basket), merge deduplicated currently-valid offers. Marktguru has no catalog-wide endpoint; this is the closest equivalent.
- `find_stores_nearby(address, radiusKm?)` — geocode an address via OpenStreetMap Nominatim, return supermarkets within a radius from OSM (`amenity=supermarket`) with distance + matched Marktguru retailer slug.
- `geocode_address(address)` — geocode a free-text address to lat/lng/zip via Nominatim.

`address` is accepted as alias for `zipCode` in `search_offers` and `get_weekly_offers`. If both supplied, `address` is geocoded and the resulting zip wins.

## Auth

Marktguru gates the API with two headers (`x-apikey`, `x-clientkey`) embedded in the homepage HTML as inline JSON (`"apiKey":"..."`, `"clientKey":"..."`). The server scrapes them on first run, caches at `~/.marktguru/keys.json` for 24h, and re-scrapes on 401/403.

Nominatim is free public OSM endpoint; sets `User-Agent: food-planner-mcp/<version>` per usage policy.

## Run

```bash
bun install
bun run src/index.ts        # stdio MCP server
bunx tsc --noEmit           # typecheck
```

First run installs deps automatically via `bin/serve.sh`.

## .mcp.json wiring

Project-scope (this repo's `.mcp.json`): absolute path to `bin/serve.sh`.

As installable plugin: use `${CLAUDE_PLUGIN_ROOT}/mcp-servers/supermarkets-mcp/bin/serve.sh`.
