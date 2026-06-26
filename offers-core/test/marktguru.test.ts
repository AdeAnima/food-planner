import { test, expect } from "bun:test";
import { normalizeMarktguru } from "../src/retailers/marktguru.ts";
import fixture from "./fixtures/marktguru-offers.json";

const offers = (fixture as any).results as any[];

test("normalizeMarktguru maps a real fixture offer to a slim RawOffer", () => {
  const priced = offers.find((o) => Number(o.price) > 0);
  expect(priced).toBeDefined();
  const n = normalizeMarktguru(priced);
  expect(n.offerId).toBe(String(priced.id));
  expect(n.title).toBe(String(priced.description).trim());
  expect(n.price).toBe(Math.round(Number(priced.price) * 100));
  expect(Number.isInteger(n.price)).toBe(true);
  expect(n.category).toBe(String((priced.categories ?? [])[0]?.name ?? "Sonstiges"));
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.validTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.raw).toBe(priced);
});

test("every fixture offer normalizes to the slim contract (price null or integer cents)", () => {
  for (const o of offers) {
    const n = normalizeMarktguru(o);
    expect(n.offerId).toBeString();
    expect(n.title).toBeString();
    expect(n.price === null || Number.isInteger(n.price)).toBe(true);
  }
});

test("normalizeMarktguru price gate: 0/missing/negative/non-numeric -> null, >0 -> cents", () => {
  expect(normalizeMarktguru({ id: 1, description: "t", price: 0 }).price).toBeNull();
  expect(normalizeMarktguru({ id: 2, description: "t" }).price).toBeNull();          // missing
  expect(normalizeMarktguru({ id: 3, description: "t", price: -5 }).price).toBeNull();
  expect(normalizeMarktguru({ id: 4, description: "t", price: "n/a" }).price).toBeNull();
  expect(normalizeMarktguru({ id: 5, description: "t", price: 1.99 }).price).toBe(199);
});

test("normalizeMarktguru reads validityDates array + categories array (not singular)", () => {
  const n = normalizeMarktguru({
    id: 9, description: "Bio Äpfel", price: 1.49,
    validityDates: [{ from: "2026-07-01T22:00:00Z", to: "2026-07-04T21:59:00Z" }],
    categories: [{ id: 1, name: "Obst" }],
  });
  expect(n.validFrom).toBe("2026-07-01");
  expect(n.validTo).toBe("2026-07-04");
  expect(n.category).toBe("Obst");
});

test("marktguruOffers throws when terms is empty (no catalog endpoint)", () => {
  // marktguruOffers must reject empty terms WITHOUT a live call.
  expect(import("../src/retailers/marktguru.ts").then((m) => m.marktguruOffers("80331", [])))
    .rejects.toThrow(/terms required/);
});
