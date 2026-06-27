// test/lidl.test.ts
import { test, expect } from "bun:test";
import { normalizeLidl } from "../src/retailers/lidl.ts";
import fixture from "./fixtures/lidl-offers.json";

test("normalizeLidl emits null price for percentage-off offer", () => {
  const raw = (fixture as any).offers[0];
  expect(normalizeLidl(raw).price).toBeNull();
});

test("normalizeLidl price contract: finite+positive → cents, else null", () => {
  expect(normalizeLidl({ priceBox: { largePartNumeric: 1.99 } }).price).toBe(199);
  expect(normalizeLidl({ priceBox: { largePartNumeric: 0 } }).price).toBeNull();
  expect(normalizeLidl({ priceBox: { largePartNumeric: -1 } }).price).toBeNull();
  expect(normalizeLidl({ priceBox: { largePartNumeric: "" } }).price).toBeNull();
  expect(normalizeLidl({}).price).toBeNull();
  expect(normalizeLidl({ priceBox: {} }).price).toBeNull();
});

test("normalizeLidl maps a real euro price to integer cents", () => {
  const raw = (fixture as any).offers.find((o: any) => o.priceBox?.largePartNumeric != null);
  expect(raw).toBeDefined();
  const n = normalizeLidl(raw);
  expect(Number.isInteger(n.price)).toBe(true);
  expect(n.price).toBeGreaterThan(0);
});

test("normalizeLidl shape: offerId, title, validFrom, raw", () => {
  const rawOffer = (fixture as any).offers.find((o: any) => o.priceBox?.largePartNumeric != null);
  const n = normalizeLidl(rawOffer);
  expect(n.offerId).toBeString();
  expect(n.title).toBeString();
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.raw).toBe(rawOffer);
});
