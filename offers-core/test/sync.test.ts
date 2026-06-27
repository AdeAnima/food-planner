// test/sync.test.ts
import { test, expect } from "bun:test";
import { checkAnomaly } from "../src/core/sync.ts";
import { openDb, upsertOffers, weekCount } from "../src/core/db.ts";
import type { RawOffer } from "../src/core/types.ts";

test("no anomaly when counts comparable", () => {
  expect(checkAnomaly(100, 90)).toBe(false);
});
test("anomaly when this week collapses to near-zero", () => {
  expect(checkAnomaly(2, 100)).toBe(true);
});
test("anomaly when this week explodes", () => {
  expect(checkAnomaly(500, 100)).toBe(true);
});
test("no anomaly on first-ever sync (no prior data)", () => {
  expect(checkAnomaly(50, 0)).toBe(false);
});

// Regression: multi-cycle fetch — weekCount must count only the target week's rows
test("weekCount only counts rows for the specified weekKey", () => {
  const db = openDb(":memory:");

  const offers: RawOffer[] = [
    // week 2026-W26 (2026-06-22 is a Monday in W26)
    { offerId: "a1", title: "Apple", category: "fruit", price: 99, validFrom: "2026-06-22", validTo: "2026-06-28", raw: {} },
    { offerId: "a2", title: "Banana", category: "fruit", price: 149, validFrom: "2026-06-22", validTo: "2026-06-28", raw: {} },
    // week 2026-W27 (2026-06-29 is a Monday in W27)
    { offerId: "b1", title: "Cherry", category: "fruit", price: 299, validFrom: "2026-06-29", validTo: "2026-07-05", raw: {} },
    { offerId: "b2", title: "Date", category: "fruit", price: 399, validFrom: "2026-06-29", validTo: "2026-07-05", raw: {} },
    { offerId: "b3", title: "Elderberry", category: "fruit", price: 499, validFrom: "2026-06-29", validTo: "2026-07-05", raw: {} },
  ];

  upsertOffers(db, "test-retailer", "DE-SOUTH", "region", offers);

  // Target week is W26 — should see exactly 2 rows, not all 5
  const count = weekCount(db, "test-retailer", "DE-SOUTH", "2026-W26");
  expect(count).toBe(2);

  // Sanity: W27 has 3 rows
  const countW27 = weekCount(db, "test-retailer", "DE-SOUTH", "2026-W27");
  expect(countW27).toBe(3);
});
