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
  expect(getRaw(db, "a", "lidl")).toEqual({ id: "a" });
});

test("weekCount counts rows for a region-week", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [mk("a", "2026-06-29"), mk("b", "2026-06-29")]);
  expect(weekCount(db, "lidl", "DE-BW", "2026-W27")).toBe(2);
});
