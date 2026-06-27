import { test, expect } from "bun:test";
import { normalizeEdeka } from "../src/retailers/edeka.ts";
import fixture from "./fixtures/edeka-offers.json";

const offers = fixture as any[];

test("normalizeEdeka emits null price for a HIDE offer", () => {
  const hide = offers.find((o) => o.priceType === "HIDE");
  expect(hide).toBeDefined();
  expect(normalizeEdeka(hide).price).toBeNull();
});

test("normalizeEdeka maps a SHOW offer to exact integer cents", () => {
  const show = offers.find((o) => o.priceType === "SHOW" && Number(o.price?.rawValue) > 0);
  expect(show).toBeDefined();
  const n = normalizeEdeka(show);
  expect(n.price).toBe(Math.round(Number(show.price.rawValue) * 100));
  expect(Number.isInteger(n.price)).toBe(true);
  expect(n.offerId).toBeString();
  expect(n.category).toBe("Sonstiges");
  expect(n.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(n.raw).toBe(show);
});
