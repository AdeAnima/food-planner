import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGermanZip, geocode } from "../src/core/geocode.ts";

test("isGermanZip: 5 digits true, else false", () => {
  expect(isGermanZip("80331")).toBe(true);
  expect(isGermanZip(" 80331 ")).toBe(true);
  expect(isGermanZip("8033")).toBe(false);
  expect(isGermanZip("munich")).toBe(false);
});

const origFetch = globalThis.fetch;
const origContact = process.env.WEEKPLAN_CONTACT;
const origCacheDir = process.env.OFFERS_CORE_CACHE_DIR;
let tmpCacheDir: string;

beforeEach(() => {
  // ponytail: fresh temp dir per test — keeps tests hermetic, never touches $HOME
  tmpCacheDir = mkdtempSync(join(tmpdir(), "geocode-test-"));
  process.env.OFFERS_CORE_CACHE_DIR = tmpCacheDir;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origContact === undefined) delete process.env.WEEKPLAN_CONTACT;
  else process.env.WEEKPLAN_CONTACT = origContact;
  if (origCacheDir === undefined) delete process.env.OFFERS_CORE_CACHE_DIR;
  else process.env.OFFERS_CORE_CACHE_DIR = origCacheDir;
  rmSync(tmpCacheDir, { recursive: true, force: true });
});

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

// Finding 2: WEEKPLAN_CONTACT missing on network path -> throws
test("missing WEEKPLAN_CONTACT on cache-miss path throws", async () => {
  delete process.env.WEEKPLAN_CONTACT;
  // fresh empty cache (guaranteed by beforeEach), so it will attempt network call
  globalThis.fetch = mock(async () => { throw new Error("should not reach"); }) as any;
  await expect(geocode("Marienplatz München")).rejects.toThrow("WEEKPLAN_CONTACT");
});

// Finding 3: multiple results with DISTINCT postcodes -> ambiguous error + candidates
test("ambiguous query (distinct postcodes) -> error with candidates", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.137", lon: "11.575", display_name: "Marienplatz, München", address: { postcode: "80331" } },
    { lat: "48.150", lon: "11.580", display_name: "Schwabing, München", address: { postcode: "80802" } },
  ]), { status: 200 })) as any;
  const r = await geocode("München") as any;
  expect(r.error).toMatch(/ambiguous/);
  expect(Array.isArray(r.candidates)).toBe(true);
  expect(r.candidates.length).toBe(2);
});

// Finding 3: multiple results with SAME postcode -> not ambiguous, resolves normally
test("multiple results same postcode -> resolves normally (not ambiguous)", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.137", lon: "11.575", display_name: "Marienplatz 1, München", address: { postcode: "80331" } },
    { lat: "48.138", lon: "11.576", display_name: "Marienplatz 2, München", address: { postcode: "80331" } },
  ]), { status: 200 })) as any;
  const r = await geocode("Marienplatz München") as any;
  expect(r.zip).toBe("80331");
  expect(r.error).toBeUndefined();
  expect(r.lat).toBeCloseTo(48.137, 2);
});

// Finding 3: bare zip with multiple results with distinct postcodes -> NOT ambiguous (zip-query bypass)
test("bare zip query with multiple results -> approximate true, never ambiguous", async () => {
  process.env.WEEKPLAN_CONTACT = "test@example.com";
  globalThis.fetch = mock(async () => new Response(JSON.stringify([
    { lat: "48.14", lon: "11.58", display_name: "80331 München", address: { postcode: "80331" } },
    { lat: "48.15", lon: "11.59", display_name: "80802 München", address: { postcode: "80802" } },
  ]), { status: 200 })) as any;
  const r = await geocode("80331") as any;
  // bare-zip path bypasses ambiguity; uses top result
  expect(r.approximate).toBe(true);
  expect(r.zip).toBe("80331");
  expect(r.error).toBeUndefined();
});
