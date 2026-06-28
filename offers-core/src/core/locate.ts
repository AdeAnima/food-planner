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
