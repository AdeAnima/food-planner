import { test, expect } from "bun:test";
import { reweOffers } from "../src/retailers/rewe.ts";

test("reweOffers is deferred and throws clearly", async () => {
  expect(reweOffers("80331")).rejects.toThrow(/deferred|not implemented/i);
});
