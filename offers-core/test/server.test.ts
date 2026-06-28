// test/server.test.ts
import { test, expect } from "bun:test";
import { makeApp } from "../src/server.ts";
import { openDb } from "../src/index.ts";
import { upsertOffers, upsertStores } from "../src/core/db.ts";
import type { Store } from "../src/core/types.ts";

function seedStores() {
  const db = openDb(":memory:");
  const stores: Store[] = [
    { retailer: "lidl", storeId: "L1", name: "Lidl Mitte", zip: "80331", lat: 48.137, lon: 11.575, region: "L1", gln: "", scope: "region" },
    { retailer: "lidl", storeId: "L2", name: "Lidl Nord",  zip: "80807", lat: 48.18,  lon: 11.59,  region: "L2", gln: "", scope: "region" },
  ];
  upsertStores(db, stores);
  return db;
}

function seed() {
  const db = openDb(":memory:");
  upsertOffers(db, "lidl", "DE-BW", "region", [{
    offerId: "a", title: "Lachs", category: "Fisch", price: 599,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { price: { value: 5.99 } },
  }]);
  return db;
}

test("GET /offers returns slim JSON array", async () => {
  const app = makeApp(seed());
  // explicit validOn inside the seed window — avoids the today-default filtering it out
  const res = await app(new Request("http://x/offers?retailers=lidl&validOn=2026-06-30"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0].title).toBe("Lachs");
  expect(body[0].raw).toBeUndefined(); // slim
});

test("GET /offers/:id?groups=pricing returns detail (full composite key)", async () => {
  const app = makeApp(seed());
  const res = await app(new Request(
    "http://x/offers/a?retailer=lidl&storeOrRegionKey=DE-BW&validFrom=2026-06-29&groups=pricing"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pricing.price).toEqual({ value: 5.99 });
});

test("GET /offers/:id with wrong composite key -> 404", async () => {
  const app = makeApp(seed());
  const res = await app(new Request(
    "http://x/offers/a?retailer=lidl&storeOrRegionKey=DE-XX&validFrom=2026-06-29&groups=pricing"));
  expect(res.status).toBe(404);
});

test("unknown route -> 404", async () => {
  const app = makeApp(seed());
  const res = await app(new Request("http://x/nope"));
  expect(res.status).toBe(404);
});

test("GET /stores?retailer=lidl&lat&lon -> nearest sorted with key + distKm", async () => {
  const app = makeApp(seedStores());
  const res = await app(new Request("http://x/stores?retailer=lidl&lat=48.137&lon=11.575"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0].storeId).toBe("L1");
  expect(body[0].key).toBe("L1");
  expect(typeof body[0].distKm).toBe("number");
});

test("GET /stores?retailer=lidl (no coords) -> listStores", async () => {
  const app = makeApp(seedStores());
  const res = await app(new Request("http://x/stores?retailer=lidl"));
  const body = await res.json();
  expect(body.length).toBe(2);
  expect(body[0].distKm).toBeUndefined(); // listStores, no distance
});

test("GET /stores?retailer=lidl filters by retailer (listStores)", async () => {
  const db = seedStores();
  // add a non-lidl row; the retailer filter must exclude it
  upsertStores(db, [
    { retailer: "penny", storeId: "P1", name: "Penny", zip: "80331", lat: 48.1, lon: 11.5, region: "R1", gln: "", scope: "region" },
  ]);
  const app = makeApp(db);
  const res = await app(new Request("http://x/stores?retailer=lidl"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBe(2);
  expect(body.every((s: Store) => s.retailer === "lidl")).toBe(true);
});

test("GET /stores?scope=region filters by scope (no coords, listStores)", async () => {
  const db = seedStores();
  upsertStores(db, [
    { retailer: "kaufland", storeId: "K1", name: "Kaufland", zip: "80331", lat: 48.1, lon: 11.5, region: "", gln: "", scope: "national" },
  ]);
  const app = makeApp(db);
  const res = await app(new Request("http://x/stores?scope=region"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.every((s: Store) => s.scope === "region")).toBe(true);
  expect(body.some((s: Store) => s.scope === "national")).toBe(false);
});

test("POST /sync?retailers=lidl rejects keyed retailer (no network)", async () => {
  // non-kaufland retailers need a resolved key — route must reject loudly, not fire an undefined-key fetch
  const app = makeApp(openDb(":memory:"));
  const res = await app(new Request("http://x/sync?retailers=lidl", { method: "POST" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([{ retailer: "lidl", error: "needs key resolution (offers-mcp layer)" }]);
});
