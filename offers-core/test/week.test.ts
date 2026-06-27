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
test("Dec 31 2029 (Monday) belongs to ISO week 1 of 2030", () => {
  expect(isoWeekKey("2029-12-31")).toBe("2030-W01");
});
test("Jan 1 2022 (Saturday) belongs to ISO week 52 of 2021", () => {
  expect(isoWeekKey("2022-01-01")).toBe("2021-W52");
});
test("Jan 1 2023 (Sunday) belongs to ISO week 52 of 2022", () => {
  expect(isoWeekKey("2023-01-01")).toBe("2022-W52");
});
test("rejects impossible calendar date", () => {
  expect(() => isoWeekKey("2026-02-31")).toThrow(/impossible|invalid/i);
});
test("rejects malformed string", () => {
  expect(() => isoWeekKey("abcd")).toThrow(/invalid date format/i);
});
test("rejects wrong format", () => {
  expect(() => isoWeekKey("2026-6-1")).toThrow(/invalid date format/i);
});
