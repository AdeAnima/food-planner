// test/index.test.ts
import { test, expect } from "bun:test";
import { openDb, getOffers, getOfferDetails, RETAILERS } from "../src/index.ts";
import { upsertOffers } from "../src/core/db.ts";

test("RETAILERS lists all six", () => {
  expect(Object.keys(RETAILERS).sort()).toEqual(
    ["edeka", "kaufland", "lidl", "marktguru", "penny", "rewe"]);
});

test("getOffers applies filter end-to-end (explicit validOn inside window)", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { x: 1 },
  }]);
  // pass explicit validOn inside the window so the today-default doesn't filter it out
  const rows = getOffers(db, { retailers: ["lidl"], q: "Lachs", validOn: "2026-06-30" });
  expect(rows.length).toBe(1);
});

test("getOffers default validOn=today filters out not-yet-valid offers", () => {
  const db = openDb(":memory:");
  // valid only in the future relative to a 2026-06-27 'today' — default should exclude it
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "future", title: "Future", category: "X", price: 100,
    validFrom: "2099-01-01", validTo: "2099-01-07", raw: {},
  }]);
  expect(getOffers(db, { retailers: ["lidl"] }).length).toBe(0);
  // but an explicit validOn in its window finds it
  expect(getOffers(db, { retailers: ["lidl"], validOn: "2099-01-03" }).length).toBe(1);
});

test("weekKey query is NOT clobbered by the today-default", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "wk", title: "Week", category: "X", price: 100,
    validFrom: "2099-01-01", validTo: "2099-01-07", raw: {},
  }]);
  // weekKey selects the row even though it is not valid "today" — proves validOn default is gated off
  const wk = getOffers(db, { retailers: ["lidl"], weekKey: "2099-W01" });
  expect(wk.length).toBe(1);
});

test("cost filter (priceMax) excludes NULL-price rows via SQL 3VL", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [
    { offerId: "priced", title: "P", category: "X", price: 300,
      validFrom: "2026-06-01", validTo: "2099-12-31", raw: {} },
    { offerId: "noprice", title: "N", category: "X", price: null,
      validFrom: "2026-06-01", validTo: "2099-12-31", raw: {} },
  ]);
  const rows = getOffers(db, { retailers: ["lidl"], priceMax: 500, validOn: "2026-06-30" });
  expect(rows.map(r => r.offerId)).toEqual(["priced"]); // NULL-price row dropped
});

test("getOfferDetails projects raw via full composite key", () => {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { price: { value: 5.99 } },
  }]);
  const d = getOfferDetails(db, "lidl", "DE-BW", "a", "2026-06-29", ["pricing"]) as any;
  expect(d.pricing.price).toEqual({ value: 5.99 });
});

test("getOfferDetails returns null when composite key misses", () => {
  const db = openDb(":memory:");
  expect(getOfferDetails(db, "lidl", "DE-BW", "nope", "2026-06-29", ["raw"])).toBeNull();
});
