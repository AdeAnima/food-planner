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
