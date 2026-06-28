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
