import { test, expect } from "bun:test";
import { isCurrentlyValid, type Offer, type OfferValidity } from "./marktguru.ts";

const DAY = 24 * 3600 * 1000;

function offer(validityDates?: OfferValidity[]): Offer {
  return { id: 1, description: "x", price: 1, oldPrice: null, validityDates } as Offer;
}

test("no validityDates → always valid", () => {
  expect(isCurrentlyValid(offer(), Date.now())).toBe(true);
  expect(isCurrentlyValid(offer([]), Date.now())).toBe(true);
});

test("before the from date → invalid", () => {
  const from = Date.parse("2026-05-20");
  const o = offer([{ from: "2026-05-20" }]);
  expect(isCurrentlyValid(o, from - 1)).toBe(false);
});

test("explicit date-only 'to' stays valid through the whole final day", () => {
  // valid until 2026-05-31 → grace makes it valid through end of May 31
  const o = offer([{ from: "2026-05-25", to: "2026-05-31" }]);
  const endOfDay31 = Date.parse("2026-05-31") + DAY - 1; // 23:59:59.999
  const startOfJun1 = Date.parse("2026-06-01") + 1;      // just past the grace
  expect(isCurrentlyValid(o, endOfDay31)).toBe(true);
  expect(isCurrentlyValid(o, startOfJun1)).toBe(false);
});

test("grace is exactly one day, not two (no 8-day drift)", () => {
  const o = offer([{ from: "2026-05-25", to: "2026-05-31" }]);
  const justOverGrace = Date.parse("2026-05-31") + DAY + 1; // 1ms past the +24h grace
  expect(isCurrentlyValid(o, justOverGrace)).toBe(false);
});

test("'until' alias behaves like 'to'", () => {
  const o = offer([{ from: "2026-05-25", until: "2026-05-31" }]);
  const within = Date.parse("2026-05-31") + DAY - 1;
  expect(isCurrentlyValid(o, within)).toBe(true);
});

test("default window (no explicit end) is exactly 7 days, no extra grace", () => {
  const from = Date.parse("2026-05-25");
  const o = offer([{ from: "2026-05-25" }]);
  expect(isCurrentlyValid(o, from + 7 * DAY)).toBe(true);      // boundary inclusive
  expect(isCurrentlyValid(o, from + 7 * DAY + 1)).toBe(false); // 1ms past 7 days
});

test("unparseable 'from' → that validity entry is rejected", () => {
  const o = offer([{ from: "not-a-date" }]);
  expect(isCurrentlyValid(o, Date.now())).toBe(false);
});

test("unparseable explicit end falls back to 7-day window from 'from'", () => {
  const from = Date.parse("2026-05-25");
  const o = offer([{ from: "2026-05-25", to: "garbage" }]);
  expect(isCurrentlyValid(o, from + 3 * DAY)).toBe(true);
  expect(isCurrentlyValid(o, from + 8 * DAY)).toBe(false);
});

test("multiple validity windows → valid if any matches", () => {
  const o = offer([
    { from: "2026-01-01", to: "2026-01-07" },
    { from: "2026-05-25", to: "2026-05-31" },
  ]);
  const inSecond = Date.parse("2026-05-27");
  expect(isCurrentlyValid(o, inSecond)).toBe(true);
});
