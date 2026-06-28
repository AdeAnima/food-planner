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

test("findStores returns nearest with key + distKm (pre-seeded; populate skipped, non-empty)", async () => {
  // DB pre-seeded → listStores non-empty → populateStores NOT called → no network. Resolves rows.
  const h = makeHandlers(seed());
  const r = (await h.findStores("lidl", 48.137, 11.575)) as any[];
  expect(r[0].key).toBe("L1");
  expect(typeof r[0].distKm).toBe("number");
});

test("findStores swallows a populate failure on empty DB and returns [] (no network)", async () => {
  // Empty DB → enters the populate branch. kaufland has NO geo store-fn, so populateStores
  // throws SYNCHRONOUSLY (no HTTP). findStores must swallow it and resolve []. Delete the
  // try/catch in handlers.ts and the throw escapes → this await rejects → test fails.
  const h = makeHandlers(openDb(":memory:"));
  const r = (await h.findStores("kaufland", 48.137, 11.575)) as any[];
  expect(r).toEqual([]);
});

test("searchOffers on empty DB returns empty array", () => {
  const h = makeHandlers(seed());
  expect((h.searchOffers({ retailers: ["lidl"] }) as any[]).length).toBe(0);
});
