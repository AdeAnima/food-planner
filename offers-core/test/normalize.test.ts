import { test, expect } from "bun:test";
import { projectGroups } from "../src/core/normalize.ts";

const raw = {
  price: { value: 1.99, was: 2.49, deposit: 0.25 },
  category: { name: "Obst" }, brand: "Bio",
  images: ["a.jpg"], flyerPage: 3,
  misc: "keep-in-raw",
};

test("raw group returns whole object", () => {
  expect(projectGroups(raw, ["raw"]).raw).toEqual(raw);
});
test("all returns every group incl raw", () => {
  const r = projectGroups(raw, ["all"]);
  expect(r.raw).toEqual(raw);
  expect(r.pricing).toBeDefined();
  expect(r.media).toBeDefined();
});
test("pricing picks price-ish keys", () => {
  const r = projectGroups(raw, ["pricing"]) as any;
  expect(r.pricing.price).toEqual({ value: 1.99, was: 2.49, deposit: 0.25 });
});
test("media picks images + flyer", () => {
  const r = projectGroups(raw, ["media"]) as any;
  expect(r.media.images).toEqual(["a.jpg"]);
});
test("classification picks category + brand", () => {
  const r = projectGroups(raw, ["classification"]) as any;
  expect(r.classification.category).toEqual({ name: "Obst" });
  expect(r.classification.brand).toBe("Bio");
});
test("missing keys are simply absent, no crash on null/non-object raw", () => {
  expect(projectGroups(null, ["pricing"])).toEqual({ pricing: {} });
  expect(projectGroups({ price: 1 }, ["media"])).toEqual({ media: {} });
});
