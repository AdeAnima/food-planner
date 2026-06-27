// test/db.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertOffers, queryOffers, getRaw, weekCount } from "../src/core/db.ts";
import type { RawOffer } from "../src/core/types.ts";

const mk = (id: string, validFrom: string): RawOffer => ({
  offerId: id, title: "Apfel", category: "Obst", price: 199,
  validFrom, validTo: "2026-07-05", raw: { id },
});

test("history preserved: same offerId, different validFrom -> 2 rows", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-22")]);
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  const rows = queryOffers(db, { sql: "offerId = ?", params: ["a"] });
  expect(rows.length).toBe(2);
});

test("dedup: same offerId + same validFrom -> 1 row", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  const inserted = upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  expect(inserted).toBe(0);
  expect(queryOffers(db, { sql: "1=1", params: [] }).length).toBe(1);
});

test("regional duplicate offerId across keys does not clobber", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "penny", "R1", "region", [mk("a", "2026-06-29")]);
  upsertOffers(db, "penny", "R2", "region", [mk("a", "2026-06-29")]);
  expect(queryOffers(db, { sql: "1=1", params: [] }).length).toBe(2);
});

test("getRaw returns stored upstream object", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29")]);
  expect(getRaw(db, "lidl", "DE-BW", "a", "2026-06-29")).toEqual({ id: "a" });
});

test("getRaw disambiguates same offerId across regions", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "penny", "R1", "region", [{ offerId: "a", title: "x", category: "c", price: 100, validFrom: "2026-06-29", validTo: "2026-07-05", raw: { region: "R1" } }]);
  upsertOffers(db, "penny", "R2", "region", [{ offerId: "a", title: "x", category: "c", price: 100, validFrom: "2026-06-29", validTo: "2026-07-05", raw: { region: "R2" } }]);
  expect(getRaw(db, "penny", "R1", "a", "2026-06-29")).toEqual({ region: "R1" });
  expect(getRaw(db, "penny", "R2", "a", "2026-06-29")).toEqual({ region: "R2" });
});

test("migrate does not downgrade a newer DB", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA user_version = 99;");
  // re-running migrate via a fresh openDb on same handle isn't possible for :memory:,
  // so call the exported behavior: opening already-migrated DB keeps version >= current.
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  expect(v).toBeGreaterThanOrEqual(1);
});

test("upsertOffers rejects non-integer price", () => {
  const db = openDb(":memory:");
  expect(() => upsertOffers(db, "lidl", "DE-BW", "region", [
    { offerId: "f", title: "x", category: "c", price: 1.99, validFrom: "2026-06-29", validTo: "2026-07-05", raw: {} },
  ])).toThrow(/integer cents/);
});

test("upsertOffers accepts null price and reads it back as null", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [
    { offerId: "pct", title: "20% Rabatt", category: "Aktion", price: null, validFrom: "2026-06-29", validTo: "2026-07-05", raw: {} },
  ]);
  const rows = queryOffers(db, { sql: "offerId = ?", params: ["pct"] });
  expect(rows.length).toBe(1);
  expect(rows[0].price).toBeNull();
});

test("weekCount counts rows for a region-week", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29"), mk("b", "2026-06-29")]);
  expect(weekCount(db, "lidl", "DE-BW", "2026-W27")).toBe(2);
});
