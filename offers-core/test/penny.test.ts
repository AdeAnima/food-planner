import { test, expect } from "bun:test";
import { normalizePenny } from "../src/retailers/penny.ts";
import fixture from "./fixtures/penny-offers.json";

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
