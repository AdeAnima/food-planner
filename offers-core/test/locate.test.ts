// offers-core/test/locate.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertStores, listStores } from "../src/core/db.ts";
import type { Store } from "../src/core/types.ts";

function seed(): import("bun:sqlite").Database {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
    { retailer: "lidl", storeId: "L2", name: "Lidl Nord",  zip: "80807", lat: 48.18,  lon: 11.59,  region: "L2", gln: "", scope: "region" },
    { retailer: "edeka", storeId: "E1", name: "Edeka Süd",  zip: "81541", lat: 48.10,  lon: 11.58,  region: "",   gln: "G1", scope: "store" },
  ];
  upsertStores(db, stores);
  return db;
}

test("listStores filters by retailer", () => {
  const db = seed();
  const lidls = listStores(db, { retailer: "lidl" });
  expect(lidls.length).toBe(2);
  expect(lidls.every((s) => s.retailer === "lidl")).toBe(true);
});

test("listStores no filter returns all", () => {
  expect(listStores(seed(), {}).length).toBe(3);
});
