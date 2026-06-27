// test/server.test.ts
import { test, expect } from "bun:test";
import { makeApp } from "../src/server.ts";
import { openDb } from "../src/index.ts";
import { upsertOffers } from "../src/core/db.ts";

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

test("GET /stores?retailers=kaufland returns scope (national, no geo fetch)", async () => {
  const app = makeApp(openDb(":memory:"));
  const res = await app(new Request("http://x/stores?retailers=kaufland&lat=52&lon=13"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([{ retailer: "kaufland", scope: "national" }]);
});

test("GET /stores?retailers=penny returns scope (region, no geo fetch)", async () => {
  const app = makeApp(openDb(":memory:"));
  const res = await app(new Request("http://x/stores?retailers=penny&lat=52&lon=13"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([{ retailer: "penny", scope: "region" }]);
});

test("POST /sync?retailers=lidl rejects keyed retailer (no network)", async () => {
  // non-kaufland retailers need a resolved key — route must reject loudly, not fire an undefined-key fetch
  const app = makeApp(openDb(":memory:"));
  const res = await app(new Request("http://x/sync?retailers=lidl", { method: "POST" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([{ retailer: "lidl", error: "needs key resolution (offers-mcp layer)" }]);
});
