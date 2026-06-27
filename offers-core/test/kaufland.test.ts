import { test, expect } from "bun:test";
import { parseKaufland, normalizeKaufland } from "../src/retailers/kaufland.ts";

const html = await Bun.file(new URL("./fixtures/kaufland.html", import.meta.url)).text();

test("parseKaufland extracts offers from the SSR block across both cycles", () => {
  const offers = parseKaufland(html);
  expect(offers.length).toBeGreaterThan(0);
  // every offer has the slim contract shape
  for (const o of offers) {
    expect(o.offerId).toBeString();
    expect(o.title).toBeString();
    expect(o.category).toBe("Sonstiges");
    expect(o.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(o.validTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(o.price === null || Number.isInteger(o.price)).toBe(true);
  }
});

test("parseKaufland maps a positively-priced offer to exact integer cents", () => {
  const offers = parseKaufland(html);
  const priced = offers.find((o) => o.price !== null);
  expect(priced).toBeDefined();
  expect(Number.isInteger(priced!.price)).toBe(true);
  expect(priced!.price).toBeGreaterThan(0);
});

test("parseKaufland emits null price for a price:0 / label:none offer", () => {
  const offers = parseKaufland(html);
  // the fixture contains REMINGTON (price:0, label:none) — note: another label:none offer has price:49.99,
  // so we must select by price:0 (the actual null-price indicator), not by label alone
  const nullCase = offers.find((o) => (o.raw as any).price === 0);
  expect(nullCase).toBeDefined();
  expect(nullCase!.price).toBeNull();
});

test("normalizeKaufland price gate: 0 -> null, >0 -> cents, non-finite -> null", () => {
  expect(normalizeKaufland({ offerId: "x", title: "t", price: 0 }, "2026-06-25", "2026-07-01").price).toBeNull();
  expect(normalizeKaufland({ offerId: "y", title: "t", price: 1.99 }, "2026-06-25", "2026-07-01").price).toBe(199);
  expect(normalizeKaufland({ offerId: "z", title: "t", price: "n/a" }, "2026-06-25", "2026-07-01").price).toBeNull();
});

test("parseKaufland throws when no SSR block present", () => {
  expect(() => parseKaufland("<html><body>no ssr here</body></html>")).toThrow();
});
