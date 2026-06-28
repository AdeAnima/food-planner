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

const BERLIN_TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
});
function berlinToday(): string { return BERLIN_TODAY.format(new Date()); }

export function getOffers(db: Database, query: OfferQuery): Offer[] {
  // ponytail: default to "valid today" UNLESS caller pinned an explicit date or a target week.
  // weekKey is the target-week selector — forcing validOn=today on top would empty non-current-week queries.
  const q = (!query.validOn && !query.weekKey)
    ? { ...query, validOn: berlinToday() }
    : query;
  return queryOffers(db, buildWhere(q));
}

export function getOfferDetails(
  db: Database, retailer: string, storeOrRegionKey: string,
  offerId: string, validFrom: string, groups: InfoGroup[],
): Record<string, unknown> | null {
  const raw = getRaw(db, retailer, storeOrRegionKey, offerId, validFrom);
  if (raw == null) return null;
  return { offerId, ...projectGroups(raw, groups) };
}

export { geocode } from "./core/geocode.ts";
export { listStores, upsertStores, weekCount, type StoreFilter } from "./core/db.ts";
export { resolveNearest, storeKey, populateStores, type ResolvedStore } from "./core/locate.ts";
export { isoWeekKey } from "./core/week.ts";
export type { Store } from "./core/types.ts";
