// src/core/sync.ts
import type { Database } from "bun:sqlite";
import type { RawOffer, Scope } from "./types.ts";
import { upsertOffers, weekCount } from "./db.ts";

export interface SyncResult {
  retailer: string;
  key: string;
  inserted: number;
  total: number;
  anomaly: boolean;
}

export function checkAnomaly(thisWeek: number, lastWeek: number): boolean {
  if (lastWeek <= 0) return false;
  const ratio = thisWeek / lastWeek;
  return ratio < 0.3 || ratio > 3;
}

export async function syncOne(
  db: Database,
  retailer: string,
  key: string,
  scope: Scope,
  fetchFn: () => Promise<RawOffer[]>,
  weekKey: string,
  prevWeekCount: number,
): Promise<SyncResult> {
  const offers = await fetchFn();
  const inserted = upsertOffers(db, retailer, key, scope, offers);
  const thisWeek = weekCount(db, retailer, key, weekKey);
  return { retailer, key, inserted, total: offers.length, anomaly: checkAnomaly(thisWeek, prevWeekCount) };
}
