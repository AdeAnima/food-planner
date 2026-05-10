import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "food-planner-mcp/0.1 (contact: martin@westphal.pw)";
const CACHE_DIR = join(homedir(), ".marktguru");
const GEOCODE_CACHE = join(CACHE_DIR, "geocode.json");
const STORES_CACHE = join(CACHE_DIR, "stores-osm.json");
const FETCH_TIMEOUT_MS = 15000;

export interface GeocodeResult {
  lat: number;
  lon: number;
  zipCode: string;
  displayName: string;
  city?: string;
  cachedAt: number;
}

export interface NearbyStore {
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  retailerSlug: string | null;
  address?: string;
  osmId: number;
  osmType: string;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function readJsonCache<T>(path: string): Promise<Record<string, T>> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, T>;
  } catch {
    return {};
  }
}

async function writeJsonCache<T>(path: string, data: Record<string, T>): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

export function isGermanZip(input: string): boolean {
  return /^\d{5}$/.test(input.trim());
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const key = address.trim().toLowerCase();
  if (!key) throw new Error("geocode: address is required");

  const cache = await readJsonCache<GeocodeResult>(GEOCODE_CACHE);
  const cached = cache[key];
  if (cached && Date.now() - cached.cachedAt < 30 * 24 * 3600 * 1000) {
    return cached;
  }

  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "de");
  url.searchParams.set("limit", "1");

  const r = await fetchWithTimeout(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" } });
  if (!r.ok) throw new Error(`Nominatim geocode failed: ${r.status} ${await r.text()}`);

  const results = (await r.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address?: { postcode?: string; city?: string; town?: string; village?: string; municipality?: string };
  }>;

  if (results.length === 0) throw new Error(`geocode: no result for address "${address}"`);
  const top = results[0]!;
  const zipCode = top.address?.postcode ?? "";
  if (!isGermanZip(zipCode)) throw new Error(`geocode: result has no German postcode (got "${zipCode}")`);

  const out: GeocodeResult = {
    lat: parseFloat(top.lat),
    lon: parseFloat(top.lon),
    zipCode,
    displayName: top.display_name,
    city: top.address?.city ?? top.address?.town ?? top.address?.village ?? top.address?.municipality,
    cachedAt: Date.now(),
  };

  cache[key] = out;
  await writeJsonCache(GEOCODE_CACHE, cache);
  return out;
}

const RETAILER_BRAND_MAP: Array<{ pattern: RegExp; slug: string }> = [
  { pattern: /\blidl\b/i, slug: "lidl" },
  { pattern: /\baldi\s*s[üu]d\b/i, slug: "aldi-sued" },
  { pattern: /\baldi\s*nord\b/i, slug: "aldi-nord" },
  { pattern: /\baldi\b/i, slug: "aldi-sued" },
  { pattern: /\brewe[ -]center\b/i, slug: "rewe-center" },
  { pattern: /\brewe\b/i, slug: "rewe" },
  { pattern: /\be[ -]?center\b/i, slug: "edeka-center" },
  { pattern: /\bedeka\b/i, slug: "edeka" },
  { pattern: /\bpenny\b/i, slug: "penny" },
  { pattern: /\bnetto\s+marken[ -]?discount\b/i, slug: "netto-marken-discount" },
  { pattern: /\bnetto\b/i, slug: "netto-marken-discount" },
  { pattern: /\bkaufland\b/i, slug: "kaufland" },
  { pattern: /\bnorma\b/i, slug: "norma" },
  { pattern: /\bnahkauf\b/i, slug: "nahkauf" },
];

function mapBrandToRetailer(name: string): string | null {
  for (const { pattern, slug } of RETAILER_BRAND_MAP) {
    if (pattern.test(name)) return slug;
  }
  return null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

export async function findStoresNearby(lat: number, lon: number, radiusKm = 3): Promise<NearbyStore[]> {
  const radiusM = Math.round(radiusKm * 1000);
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusM}`;
  const cache = await readJsonCache<{ stores: NearbyStore[]; cachedAt: number }>(STORES_CACHE);
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < 7 * 24 * 3600 * 1000) {
    return cached.stores;
  }

  const query = `
[out:json][timeout:25];
(
  node["shop"~"supermarket|discount_supermarket"](around:${radiusM},${lat},${lon});
  way["shop"~"supermarket|discount_supermarket"](around:${radiusM},${lat},${lon});
);
out center tags;
`.trim();

  const r = await fetchWithTimeout(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: `data=${encodeURIComponent(query)}`,
  }, 30000);
  if (!r.ok) throw new Error(`Overpass query failed: ${r.status} ${await r.text()}`);
  const json = (await r.json()) as OverpassResponse;

  const stores: NearbyStore[] = [];
  for (const el of json.elements) {
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (elLat === undefined || elLon === undefined) continue;
    const tags = el.tags ?? {};
    const name = tags.name || tags.brand || tags.operator || "Unknown";
    const retailerSlug = mapBrandToRetailer(tags.brand ?? "") ?? mapBrandToRetailer(name);
    stores.push({
      name,
      lat: elLat,
      lon: elLon,
      distanceKm: Number(haversineKm(lat, lon, elLat, elLon).toFixed(2)),
      retailerSlug,
      address: [tags["addr:street"], tags["addr:housenumber"], tags["addr:postcode"], tags["addr:city"]]
        .filter(Boolean)
        .join(" ") || undefined,
      osmId: el.id,
      osmType: el.type,
    });
  }

  stores.sort((a, b) => a.distanceKm - b.distanceKm);
  cache[cacheKey] = { stores, cachedAt: Date.now() };
  await writeJsonCache(STORES_CACHE, cache);
  return stores;
}

export async function resolveZipFromInput(input: { zipCode?: string; address?: string }): Promise<{ zipCode: string; geocode?: GeocodeResult }> {
  if (input.address && input.address.trim()) {
    const geo = await geocodeAddress(input.address);
    return { zipCode: geo.zipCode, geocode: geo };
  }
  if (input.zipCode && isGermanZip(input.zipCode)) {
    return { zipCode: input.zipCode.trim() };
  }
  if (input.zipCode) {
    throw new Error(`invalid German ZIP code: "${input.zipCode}". Must be 5 digits, or pass 'address' instead.`);
  }
  throw new Error("either zipCode (5 digits) or address is required");
}
