// test/lidl.test.ts
import { test, expect } from "bun:test";
import { normalizeLidl } from "../src/retailers/lidl.ts";
import fixture from "./fixtures/lidl-offers.json";

test("normalizeLidl maps a raw offer to slim RawOffer", () => {
  const rawOffer = (fixture as any).offers[0];
  const n = normalizeLidl(rawOffer);
  expect(n.offerId).toBeString();
  expect(n.title).toBeString();
  expect(Number.isInteger(n.price)).toBe(true); // cents
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.raw).toBe(rawOffer);
});
