import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const CACHE_DIR = join(homedir(), ".offers-core");
const GEOCODE_CACHE = join(CACHE_DIR, "geocode.json");
const FETCH_TIMEOUT_MS = 15000;

export function isGermanZip(input: string): boolean {
  return /^\d{5}$/.test(input.trim());
}

export interface GeocodeOk { lat: number; lon: number; zip: string; approximate: boolean; displayName: string; }
export interface GeocodeErr { error: string; candidates?: string[]; }
export type GeocodeResult = GeocodeOk | GeocodeErr;

interface CacheEntry extends GeocodeOk { cachedAt: number; }

function getUserAgent(): string {
  const contact = process.env.WEEKPLAN_CONTACT?.trim();
  if (!contact) {
    throw new Error(
      "offers-core geocode: WEEKPLAN_CONTACT env var is required (your email or URL). " +
      "Nominatim usage policy requires operator contact info in the User-Agent.",
    );
  }
  return `offers-core/0.1 (contact: ${contact})`;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o644 });
  await rename(tmp, path);
}

async function readCache(): Promise<Record<string, CacheEntry>> {
  try { return JSON.parse(await readFile(GEOCODE_CACHE, "utf8")) as Record<string, CacheEntry>; }
  catch { return {}; }
}

export async function geocode(query: string): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { error: "geocode: query is required" };
  const approximate = isGermanZip(q);

  const cacheKey = q.toLowerCase();
  const cache = await readCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.cachedAt < 30 * 24 * 3600 * 1000) {
    const { cachedAt, ...rest } = hit;
    return rest;
  }

  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "de");
  url.searchParams.set("limit", "5");

  const r = await fetchWithTimeout(url, {
    headers: { "User-Agent": getUserAgent(), "Accept-Language": "de-DE,de;q=0.9" },
  });
  if (!r.ok) return { error: `Nominatim geocode failed: ${r.status}` };

  const results = (await r.json()) as Array<{
    lat: string; lon: string; display_name: string;
    address?: { postcode?: string };
  }>;
  if (results.length === 0) return { error: `no result for "${q}"` };

  const top = results[0]!;
  const zip = top.address?.postcode ?? "";
  if (!isGermanZip(zip)) {
    return { error: `result has no German postcode for "${q}"`, candidates: results.map((x) => x.display_name) };
  }

  const out: GeocodeOk = {
    lat: parseFloat(top.lat), lon: parseFloat(top.lon), zip, approximate, displayName: top.display_name,
  };
  cache[cacheKey] = { ...out, cachedAt: Date.now() };
  await atomicWriteJson(GEOCODE_CACHE, cache);
  return out;
}
