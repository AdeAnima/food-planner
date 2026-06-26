// test/week.test.ts
import { test, expect } from "bun:test";
import { isoWeekKey } from "../src/core/week.ts";

test("Monday 2026-06-29 is ISO week 27", () => {
  expect(isoWeekKey("2026-06-29")).toBe("2026-W27");
});
test("Sunday 2026-07-05 is still week 27", () => {
  expect(isoWeekKey("2026-07-05")).toBe("2026-W27");
});
test("Jan 1 2027 (Friday) belongs to ISO week 53 of 2026", () => {
  expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
});
test("pads single-digit week", () => {
  expect(isoWeekKey("2026-01-05")).toBe("2026-W02");
});
