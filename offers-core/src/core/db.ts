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
  if (v < CURRENT_VERSION) db.exec(`PRAGMA user_version = ${CURRENT_VERSION};`);
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
      if (!Number.isInteger(o.price)) {
        throw new Error(`upsertOffers: price must be integer cents, got ${o.price} for offerId ${o.offerId}`);
      }
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

// SECURITY: `where.sql` MUST come from buildWhere() (fixed column names + ? placeholders),
// never from caller/user text — it is interpolated directly into the query.
export function queryOffers(db: Database, where: { sql: string; params: any[] }): Offer[] {
  return db.query(`SELECT ${OFFER_COLS} FROM offers WHERE ${where.sql}`).all(...where.params) as Offer[];
}

export function getRaw(
  db: Database, retailer: string, storeOrRegionKey: string, offerId: string, validFrom: string,
): unknown | null {
  const row = db.query(
    "SELECT raw FROM offers WHERE retailer=? AND storeOrRegionKey=? AND offerId=? AND validFrom=? LIMIT 1"
  ).get(retailer, storeOrRegionKey, offerId, validFrom) as { raw: string } | null;
  return row ? JSON.parse(row.raw) : null;
}

export function weekCount(db: Database, retailer: string, storeOrRegionKey: string, weekKey: string): number {
  const row = db.query("SELECT COUNT(*) AS c FROM offers WHERE retailer=? AND storeOrRegionKey=? AND weekKey=?")
    .get(retailer, storeOrRegionKey, weekKey) as { c: number };
  return row.c;
}
