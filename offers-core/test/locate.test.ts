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

import { resolveNearest, storeKey } from "../src/core/locate.ts";

test("storeKey: gln for store scope, region otherwise", () => {
  expect(storeKey({ retailer: "edeka", storeId: "E1", name: "", zip: "", lat: 0, lon: 0, region: "", gln: "G1", scope: "store" })).toBe("G1");
  expect(storeKey({ retailer: "lidl", storeId: "L1", name: "", zip: "", lat: 0, lon: 0, region: "L1", gln: "", scope: "region" })).toBe("L1");
});

test("resolveNearest returns lidl stores sorted by distance with key + distKm", () => {
  const db = seed();
  const near = resolveNearest(db, "lidl", 48.137, 11.575); // at Lidl Mitte (L1)
  expect(near.length).toBe(2);
  expect(near[0]!.storeId).toBe("L1");       // closest first
  expect(near[0]!.distKm).toBeLessThan(near[1]!.distKm);
  expect(near[0]!.key).toBe("L1");           // region key for lidl
  expect(near[0]!.distKm).toBeCloseTo(0, 1);
});

test("resolveNearest limit caps result count", () => {
  expect(resolveNearest(seed(), "lidl", 48.137, 11.575, 1).length).toBe(1);
});

import { populateStores } from "../src/core/locate.ts";

test("populateStores upserts fetched lidl stores, then resolveNearest sees them", async () => {
  const db = openDb(":memory:"); // empty — no seed()
  // stub the retailer geo fetcher: inject via the optional fetcher param (see impl)
  const fakeFetch = async (_c: string, _lat: number, _lon: number) => ([
    { retailer: "lidl", storeId: "L9", name: "Lidl Test", zip: "80331", lat: 48.137, lon: 11.575, region: "L9", gln: "", scope: "region" as const },
  ]);
  const n = await populateStores(db, "lidl", 48.137, 11.575, fakeFetch);
  expect(n).toBe(1);
  expect(listStores(db, { retailer: "lidl" }).length).toBe(1);
});

test("populateStores throws for a retailer with no geo store-fn", async () => {
  const db = openDb(":memory:");
  await expect(populateStores(db, "kaufland", 48.1, 11.5)).rejects.toThrow(/no geo store/i);
});
