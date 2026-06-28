// mcp-servers/groceries-mcp/test/handlers.test.ts
import { test, expect } from "bun:test";
import { openDb, upsertStores } from "offers-core";
import type { Store } from "offers-core";
import { makeHandlers } from "../src/handlers.ts";

function seed() {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
  ];
  upsertStores(db, stores);
  return db;
}

test("findStores returns nearest with key + distKm (pre-seeded; populate fails offline, falls through)", async () => {
  // DB pre-seeded by seed(). populateStores would hit the network for lidl; offline it
  // throws and findStores swallows it, then resolves the already-present rows. No live network.
  const h = makeHandlers(seed());
  const r = (await h.findStores("lidl", 48.137, 11.575)) as any[];
  expect(r[0].key).toBe("L1");
  expect(typeof r[0].distKm).toBe("number");
});

test("searchOffers on empty DB returns empty array", () => {
  const h = makeHandlers(seed());
  expect((h.searchOffers({ retailers: ["lidl"] }) as any[]).length).toBe(0);
});
