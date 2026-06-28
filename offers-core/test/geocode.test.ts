import { test, expect, mock, afterEach } from "bun:test";
import { isGermanZip, geocode } from "../src/core/geocode.ts";

test("isGermanZip: 5 digits true, else false", () => {
  expect(isGermanZip("80331")).toBe(true);
  expect(isGermanZip(" 80331 ")).toBe(true);
  expect(isGermanZip("8033")).toBe(false);
  expect(isGermanZip("munich")).toBe(false);
});

const origFetch = globalThis.fetch;
const origContact = process.env.WEEKPLAN_CONTACT;
afterEach(() => { globalThis.fetch = origFetch; if (origContact === undefined) delete process.env.WEEKPLAN_CONTACT; else process.env.WEEKPLAN_CONTACT = origContact; });

test("geocode street address -> approximate false", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.137", lon: "11.575", display_name: "Marienplatz, München", address: { postcode: "80331" } },
  ]), { status: 200 })) as any;
  const r = await geocode("Marienplatz München") as any;
  expect(r.zip).toBe("80331");
  expect(r.approximate).toBe(false);
  expect(r.lat).toBeCloseTo(48.137, 2);
});

test("bare zip -> approximate true", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.14", lon: "11.58", display_name: "80331 München", address: { postcode: "80331" } },
  ]), { status: 200 })) as any;
  const r = await geocode("80331") as any;
  expect(r.approximate).toBe(true);
});

test("no result -> error", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response("[]", { status: 200 })) as any;
  const r = await geocode("zzzznowhere") as any;
  expect(r.error).toBeDefined();
});
