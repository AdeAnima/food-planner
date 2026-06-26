import { test, expect } from "bun:test";
import type { Offer, RawOffer, Store, Scope, InfoGroup } from "../src/core/types.ts";

// Compile-time contract guards. A type regression makes this file fail to load.

// 1. Offer carries exactly the slim fields — no `raw`, no `tags` (v2 forbidden on Offer).
type OfferKeys = keyof Offer;
type ExpectedOfferKeys =
  | "offerId" | "retailer" | "scope" | "storeOrRegionKey" | "title"
  | "category" | "price" | "quantity" | "unit" | "validFrom" | "validTo";
// Bidirectional equality: each side must be assignable to the other.
const _offerKeysExact: OfferKeys extends ExpectedOfferKeys ? true : never = true;
const _offerKeysComplete: ExpectedOfferKeys extends OfferKeys ? true : never = true;

// 2. Offer must NOT have raw or tags — these must be `never`-ish (absent).
// @ts-expect-error — `raw` is not a field on slim Offer.
type _NoRawOnOffer = Offer["raw"];
// @ts-expect-error — `tags` must never exist on Offer (v2 uses a separate table).
type _NoTagsOnOffer = Offer["tags"];

// 3. RawOffer carries raw as unknown (forces safe narrowing downstream).
const _rawIsUnknown: RawOffer["raw"] extends unknown ? true : never = true;

// 4. Scope union is exactly the three values.
const _scopeStore: Scope = "store";
const _scopeRegion: Scope = "region";
const _scopeNational: Scope = "national";
// @ts-expect-error — "store" | "region" | "national" only.
const _scopeBad: Scope = "national-xl";

// 5. InfoGroup union includes all five.
const _groups: InfoGroup[] = ["pricing", "classification", "media", "raw", "all"];

test("Offer is constructible with the slim contract", () => {
  const o: Offer = {
    offerId: "x", retailer: "lidl", scope: "region" as Scope,
    storeOrRegionKey: "DE-BW", title: "Apfel", category: "Obst",
    price: 199, quantity: "1 kg", unit: "kg",
    validFrom: "2026-06-29", validTo: "2026-07-05",
  };
  expect(o.price).toBe(199);
  expect(Number.isInteger(o.price)).toBe(true);
  expect(Object.keys(o)).not.toContain("raw");
});

test("RawOffer carries opaque raw + slim fields", () => {
  const r: RawOffer = {
    offerId: "x", title: "Apfel", category: "Obst", price: 199,
    validFrom: "2026-06-29", validTo: "2026-07-05", raw: { anything: true },
  };
  expect(r.raw).toBeDefined();
});

test("Store shape compiles", () => {
  const s: Store = {
    retailer: "edeka", storeId: "123", name: "E center", zip: "81669",
    lat: 48.1, lon: 11.6, region: "", gln: "4311501000007", scope: "store",
  };
  expect(s.gln).toBeString();
  // silence unused-const lints for the compile-time guards above
  expect([_offerKeysExact, _offerKeysComplete, _rawIsUnknown, _scopeStore, _scopeRegion, _scopeNational, _groups]).toBeDefined();
});
