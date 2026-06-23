import { test, expect } from "bun:test";
import { isCurrentlyValid, isFoodOffer, mergeAndDedup, type Offer, type OfferValidity } from "./marktguru.ts";

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

// --- food gate ---
function withCat(name: string | undefined, extra: Partial<Offer> = {}): Offer {
  return { id: 1, description: "x", price: 1, oldPrice: null, categories: name ? [{ id: 1, name }] : undefined, ...extra } as Offer;
}

test("isFoodOffer drops non-grocery categories", () => {
  expect(isFoodOffer(withCat("Kosmetik & Drogerie"))).toBe(false);
  expect(isFoodOffer(withCat("Möbel & Wohnen"))).toBe(false);
  expect(isFoodOffer(withCat("Reise & Tickets"))).toBe(false);
  expect(isFoodOffer(withCat("Koffer"))).toBe(false);
});

test("isFoodOffer keeps food categories and unknown/empty", () => {
  expect(isFoodOffer(withCat("Rindfleisch"))).toBe(true);
  expect(isFoodOffer(withCat("Brokkoli und Kohl"))).toBe(true);
  expect(isFoodOffer(withCat(undefined))).toBe(true); // no category → keep, never silently drop
});

// --- cross-retailer dedup (reproduces getWeeklyOffers merge logic on a fixture) ---
function ofr(id: number, product: string, price: number, cat: string, retailer: string): Offer {
  return { id, description: product, price, oldPrice: null, product: { name: product }, categories: [{ id: 1, name: cat }], advertisers: [{ id: 1, name: retailer, uniqueName: retailer }] } as Offer;
}

// Tests call mergeAndDedup directly — the SAME fn getWeeklyOffers ships, so a
// future change to the merge loop breaks these tests instead of passing a stale copy.
// All fixtures omit validityDates → isCurrentlyValid is always true, so `now` is arbitrary.
const NOW = Date.parse("2026-06-23");

test("banner mirrors (same product+price, different id+retailer) collapse to one", () => {
  const offers = [
    ofr(100, "Brokkoli", 0.99, "Brokkoli und Kohl", "rewe-center"),
    ofr(101, "Brokkoli", 0.99, "Brokkoli und Kohl", "rewe"),
    ofr(102, "Brokkoli", 0.99, "Brokkoli und Kohl", "nahkauf"),
  ];
  const merged = mergeAndDedup(offers, ["rewe", "edeka"], NOW);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.advertisers?.[0]?.uniqueName).toBe("rewe"); // preferred-store row wins
});

test("dedup keeps distinct products and distinct prices", () => {
  const offers = [
    ofr(1, "Brokkoli", 0.99, "Gemüse", "rewe"),
    ofr(2, "Brokkoli", 1.29, "Gemüse", "edeka"),  // different price → kept
    ofr(3, "Karotten", 0.99, "Gemüse", "lidl"),   // different product → kept
  ];
  expect(mergeAndDedup(offers, [], NOW)).toHaveLength(3);
});

test("dedup drops non-food even when it is the only row for its key", () => {
  const offers = [ofr(1, "Haartrockner", 19.99, "Elektro & Technik", "opti-wohnwelt")];
  expect(mergeAndDedup(offers, [], NOW)).toHaveLength(0);
});

test("mergeAndDedup drops expired offers (validity gate is wired in)", () => {
  const expired = { ...ofr(1, "Brokkoli", 0.99, "Gemüse", "rewe"), validityDates: [{ from: "2026-01-01", to: "2026-01-07" }] } as Offer;
  expect(mergeAndDedup([expired], [], NOW)).toHaveLength(0);
});
