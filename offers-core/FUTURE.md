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

## Keyed multi-retailer sync
`bun run sync` and `POST /sync` are kaufland-only in v1 — only `kauflandOffers()`
is zero-arg. lidl/edeka/penny/rewe/marktguru each need a resolved key (storeKey /
gln / region / plz / zip+terms) before their fetch. Resolving those keys (geocode
→ nearest-store → store key) is the offers-mcp layer's job; once it supplies keys,
sync can fan out to all retailers. v1 rejects keyed retailers loudly rather than
firing an undefined-key fetch.
