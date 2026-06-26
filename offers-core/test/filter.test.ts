import { test, expect } from "bun:test";
import { buildWhere } from "../src/core/filter.ts";

test("empty query matches all", () => {
  expect(buildWhere({})).toEqual({ sql: "1=1", params: [] });
});

test("retailers -> IN clause", () => {
  const w = buildWhere({ retailers: ["lidl", "edeka"] });
  expect(w.sql).toContain("retailer IN (?,?)");
  expect(w.params).toEqual(["lidl", "edeka"]);
});

test("price range + validOn combine with AND", () => {
  const w = buildWhere({ priceMin: 100, priceMax: 500, validOn: "2026-06-30" });
  expect(w.sql).toBe("price >= ? AND price <= ? AND validFrom <= ? AND validTo >= ?");
  expect(w.params).toEqual([100, 500, "2026-06-30", "2026-06-30"]);
});

test("q -> LIKE with wildcards", () => {
  const w = buildWhere({ q: "Lachs" });
  expect(w.sql).toBe("title LIKE ?");
  expect(w.params).toEqual(["%Lachs%"]);
});

test("foodOnly excludes non-food categories", () => {
  const w = buildWhere({ foodOnly: true });
  expect(w.sql).toContain("category NOT IN");
  expect(w.params.length).toBeGreaterThan(0);
});

test("empty retailers array is ignored (no IN ())", () => {
  const w = buildWhere({ retailers: [] });
  expect(w.sql).toBe("1=1");
  expect(w.params).toEqual([]);
});

test("empty category array is ignored (no IN ())", () => {
  const w = buildWhere({ category: [] });
  expect(w.sql).toBe("1=1");
  expect(w.params).toEqual([]);
});
