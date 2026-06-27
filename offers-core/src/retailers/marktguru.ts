import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { RawOffer } from "../core/types.ts";

async function atomicWriteJson(path: string, data: unknown, mode = 0o644): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  await rename(tmp, path);
}

const HOMEPAGE = "https://www.marktguru.de/";
const API_BASE = "https://api.marktguru.de/api/v1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const KEY_CACHE = join(homedir(), ".marktguru", "keys.json");
const WEEKLY_OFFERS_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 15000;
let inflightKeys: Promise<MarktguruKeys> | null = null;

export interface MarktguruKeys {
  apiKey: string;
  clientKey: string;
  cachedAt: number;
}

export interface OfferAdvertiser {
  id: number;
  name: string;
  uniqueName: string;
}

export interface OfferValidity {
  from: string;
  to?: string;
  until?: string;
}

export interface OfferImageUrls {
  small?: string;
  medium?: string;
  large?: string;
}

export interface Offer {
  id: number;
  description: string;
  price: number;
  oldPrice: number | null;
  referencePrice?: number;
  brand?: { id?: number; name?: string; uniqueName?: string };
  advertisers?: OfferAdvertiser[];
  categories?: Array<{ id: number; name: string; uniqueName?: string }>;
  validityDates?: OfferValidity[];
  product?: { id?: number; name?: string };
  unit?: unknown;
  images?: { urls?: OfferImageUrls };
  type?: string;
  imageType?: string;
  requiresLoyalityMembership?: boolean;
  externalUrl?: string | null;
}

export interface SearchResponse {
  results: Offer[];
  totalResults?: number;
  degraded?: boolean;
  failedTerms?: string[];
  filters?: {
    retailers?: Array<{ uniqueName: string; name: string; count?: number }>;
    brands?: unknown[];
    categories?: unknown[];
  };
}

export interface SearchOpts {
  query: string;
  zipCode: string;
  stores?: string[];
  limit?: number;
  offset?: number;
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

async function readKeyCache(): Promise<MarktguruKeys | null> {
  try {
    const raw = await readFile(KEY_CACHE, "utf8");
    const parsed = JSON.parse(raw) as MarktguruKeys;
    if (parsed.apiKey && parsed.clientKey) return parsed;
  } catch {}
  return null;
}

async function writeKeyCache(keys: MarktguruKeys): Promise<void> {
  await mkdir(join(homedir(), ".marktguru"), { recursive: true });
  await atomicWriteJson(KEY_CACHE, keys, 0o600);
}

async function scrapeKeysFromHtml(html: string): Promise<{ apiKey: string; clientKey: string } | null> {
  const apiMatches = Array.from(html.matchAll(/"apiKey"\s*:\s*"([^"]+)"/g)).map((m) => m[1]!);
  const clientMatch = html.match(/"clientKey"\s*:\s*"([^"]+)"/);
  const apiKey = apiMatches.find((k) => /[+/=]/.test(k) && k.length >= 30 && !k.startsWith("AIza"));
  if (apiKey && clientMatch) return { apiKey, clientKey: clientMatch[1]! };
  const apiLegacy = html.match(/"x_apikey"\s*:\s*"([^"]+)"/);
  const clientLegacy = html.match(/"x_clientkey"\s*:\s*"([^"]+)"/);
  if (apiLegacy && clientLegacy) return { apiKey: apiLegacy[1]!, clientKey: clientLegacy[1]! };
  return null;
}

async function fetchKeysFromBundles(html: string): Promise<{ apiKey: string; clientKey: string } | null> {
  const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/g))
    .map((m) => m[1]!)
    .filter((s) => s.startsWith("/") || s.startsWith("http"))
    .slice(0, 25);
  for (const src of scriptSrcs) {
    const url = src.startsWith("http") ? src : new URL(src, HOMEPAGE).toString();
    try {
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const txt = await r.text();
      const found = await scrapeKeysFromHtml(txt);
      if (found) return found;
    } catch {}
  }
  return null;
}

export async function getKeys(forceRefresh = false): Promise<MarktguruKeys> {
  if (!forceRefresh) {
    const cached = await readKeyCache();
    if (cached && Date.now() - cached.cachedAt < 24 * 3600 * 1000) return cached;
  }
  if (inflightKeys) return inflightKeys;
  inflightKeys = (async () => {
    const r = await fetchWithTimeout(HOMEPAGE, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" } });
    if (!r.ok) throw new Error(`marktguru homepage fetch failed: ${r.status}`);
    const html = await r.text();
    let scraped = await scrapeKeysFromHtml(html);
    if (!scraped) scraped = await fetchKeysFromBundles(html);
    if (!scraped) throw new Error("could not scrape marktguru api keys from homepage");
    const keys: MarktguruKeys = { ...scraped, cachedAt: Date.now() };
    await writeKeyCache(keys);
    return keys;
  })().finally(() => {
    inflightKeys = null;
  });
  return inflightKeys;
}

async function apiRequest<T>(path: string, params: Record<string, string | number | string[]>, retried = false): Promise<T> {
  const keys = await getKeys();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, String(v));
  }
  const r = await fetchWithTimeout(url, {
    headers: {
      "x-apikey": keys.apiKey,
      "x-clientkey": keys.clientKey,
      Accept: "application/json",
      "User-Agent": UA,
    },
  });
  if (r.status === 401 || r.status === 403) {
    if (retried) throw new Error(`marktguru auth failed after refresh: ${r.status}`);
    await getKeys(true);
    return apiRequest<T>(path, params, true);
  }
  if (!r.ok) throw new Error(`marktguru ${path} failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export async function searchOffers(opts: SearchOpts): Promise<SearchResponse> {
  const params: Record<string, string | number | string[]> = {
    q: opts.query,
    zipCode: opts.zipCode,
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
    as: "web",
  };
  if (opts.stores && opts.stores.length > 0) params.allowedRetailers = opts.stores;
  const resp = await apiRequest<SearchResponse>("/offers/search", params);
  resp.results = resp.results ?? [];
  return resp;
}

async function allSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = { status: "fulfilled", value: await fn(items[currentIndex]!, currentIndex) };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Marktguru validity timestamps are German local-midnight expressed in UTC (e.g. T22:00:00Z = 00:00 Berlin next day).
// Convert the instant to the Europe/Berlin calendar date before slicing. en-CA locale formats as YYYY-MM-DD. DST-correct.
const BERLIN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function berlinDate(iso: string): string {
  if (!iso) return "1970-01-01";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  return BERLIN_DATE.format(d); // YYYY-MM-DD in Europe/Berlin
}

export function normalizeMarktguru(o: any): RawOffer {
  const p = Number(o.price);
  const cents = (Number.isFinite(p) && p > 0) ? Math.round(p * 100) : null;
  const v = (o.validityDates ?? [])[0] ?? {};
  return {
    offerId: String(o.id),
    title: String(o.description ?? o.brand?.name ?? "").trim(),
    category: String((o.categories ?? [])[0]?.name ?? "Sonstiges"),
    price: cents,
    quantity: undefined, // Marktguru `unit` is a unit-of-measure object {shortName,name}, not a quantity string — v2
    unit: undefined,
    validFrom: berlinDate(String(v.from ?? "")),
    validTo: berlinDate(String(v.to ?? v.until ?? "")),
    raw: o,
  };
}

// ponytail: Marktguru has no enumerate endpoint — per-term search is the only way to list offers.
export async function marktguruOffers(zipCode: string, terms: string[]): Promise<RawOffer[]> {
  if (!terms || terms.length === 0) throw new Error("marktguruOffers: terms required (Marktguru has no catalog endpoint)");
  await getKeys();
  const settled = await allSettledWithConcurrency(terms, WEEKLY_OFFERS_CONCURRENCY, (term) =>
    searchOffers({ query: term, zipCode, limit: 20 }),
  );
  const failures = settled.filter((r) => r.status === "rejected");
  // Same failure-ratio guard as the source: ≥50% term failures = real outage, not "no offers".
  if (failures.length / terms.length >= 0.5) {
    throw new Error(`marktguruOffers: ${failures.length}/${terms.length} terms failed for zip ${zipCode}`);
  }
  const offers: any[] = [];
  for (const r of settled) if (r.status === "fulfilled") offers.push(...(r.value.results ?? []));
  return offers.map(normalizeMarktguru);
}
