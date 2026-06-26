import { test, expect } from "bun:test";
import { haversineKm, nearestStore } from "../src/core/stores.ts";
import type { Store } from "../src/core/types.ts";

const st = (storeId: string, lat: number, lon: number): Store => ({
  retailer: "edeka", storeId, name: storeId, zip: "", lat, lon, region: "", gln: storeId, scope: "store",
});

test("haversine München->Berlin ~504km", () => {
  const d = haversineKm({ lat: 48.137, lon: 11.575 }, { lat: 52.52, lon: 13.405 });
  expect(d).toBeGreaterThan(490);
  expect(d).toBeLessThan(520);
});

test("nearestStore picks the closest", () => {
  const stores = [st("far", 52.52, 13.405), st("near", 48.14, 11.58)];
  expect(nearestStore(stores, 48.137, 11.575)?.storeId).toBe("near");
});

test("nearestStore on empty returns null", () => {
  expect(nearestStore([], 48, 11)).toBeNull();
});
