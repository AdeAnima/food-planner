import { test, expect, afterEach } from "bun:test";
import { normalizePenny, pennyOffers } from "../src/retailers/penny.ts";
import fixture from "./fixtures/penny-offers.json";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Mock fetch keyed by category slug -> Response. Unlisted slugs => 404.
function mockFetch(bySlug: Record<string, () => Response>) {
  globalThis.fetch = (async (url: any) => {
    const slug = String(url).split("/by-category/")[1]?.split("?")[0]?.split("/")[1] ?? "";
    return (bySlug[slug] ?? (() => new Response("", { status: 404 })))();
  }) as any;
}

const tiles = ((fixture as any).offerTiles ?? []).filter((t: any) => t.primaryType === "offer");

test("normalizePenny maps an offer tile to a slim RawOffer with integer-cents price", () => {
  const tile = tiles.find((t: any) => Number(t.price) > 0);
  expect(tile).toBeDefined();
  const n = normalizePenny(tile, "2026-26");
  expect(n.offerId).toBe(String(tile.uuid));
  expect(n.price).toBe(Math.round(Number(tile.price) * 100));
  expect(Number.isInteger(n.price)).toBe(true);
  expect(n.validFrom).toBe("2026-06-22"); // Monday of ISO week 2026-26
  expect(n.validTo).toBe("2026-06-28");   // Sunday
  expect(n.raw).toBe(tile);
});

test("normalizePenny emits null price when tile price is non-positive/unparseable", () => {
  const n = normalizePenny({ uuid: "x", title: "t", price: "0.00", primaryType: "offer" }, "2026-26");
  expect(n.price).toBeNull();
  const n2 = normalizePenny({ uuid: "y", title: "t", price: null, primaryType: "offer" }, "2026-26");
  expect(n2.price).toBeNull();
});

test("pennyOffers tolerates per-category 404 and returns offers from the rest", async () => {
  mockFetch({
    "obst-und-gemuese": () =>
      new Response(JSON.stringify({ offerTiles: [{ uuid: "a", title: "Apfel", price: "1.99", primaryType: "offer" }] }), { status: 200 }),
    // every other slug => 404 (default)
  });
  const offers = await pennyOffers("15A-04-80");
  expect(offers.length).toBe(1);
  expect(offers[0].offerId).toBe("a");
});

test("pennyOffers throws on a 5xx (real failure, not silent empty)", async () => {
  mockFetch({
    "top-angebote": () => new Response(JSON.stringify({ offerTiles: [] }), { status: 200 }),
    "obst-und-gemuese": () => new Response("", { status: 503 }),
  });
  expect(pennyOffers("15A-04-80")).rejects.toThrow(/503/);
});

test("pennyOffers throws when every category 404s (bad region indistinguishable from empty)", async () => {
  mockFetch({}); // all slugs => 404
  expect(pennyOffers("00000")).rejects.toThrow(/no category succeeded/);
});
