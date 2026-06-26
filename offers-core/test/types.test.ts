// test/types.test.ts
import { test, expect } from "bun:test";
import type { Offer, RawOffer, Store, Scope } from "../src/core/types.ts";

test("Offer shape compiles and holds expected fields", () => {
  const o: Offer = {
    offerId: "x", retailer: "lidl", scope: "region" as Scope,
    storeOrRegionKey: "DE-BW", title: "Apfel", category: "Obst",
    price: 199, quantity: "1 kg", unit: "kg",
    validFrom: "2026-06-29", validTo: "2026-07-05",
  };
  expect(o.price).toBe(199);
});

test("RawOffer carries opaque raw + slim fields", () => {
  const r: RawOffer = {
    offerId: "x", title: "Apfel", category: "Obst", price: 199,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { anything: true },
  };
  expect(r.raw).toBeDefined();
});

test("Store shape compiles", () => {
  const s: Store = {
    retailer: "edeka", storeId: "123", name: "E center", zip: "81669",
    lat: 48.1, lon: 11.6, region: "", gln: "4311501000007", scope: "store",
  };
  expect(s.gln).toBeString();
});
