import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

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

export type WeeklyOfferTermOutcome =
  | { term: string; status: "ok"; results: Offer[] }
  | { term: string; status: "error"; error?: string; results: Offer[] };

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

export interface SearchOpts {
  query: string;
  zipCode: string;
  stores?: string[];
  limit?: number;
  offset?: number;
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

export const DEFAULT_BASKET_TERMS = [
  "Lachs","Forelle","Kabeljau","Thunfisch","Garnelen",
  "Tofu","Tempeh","Linsen","Kichererbsen","Bohnen",
  "Hafermilch","Sojamilch","Mandelmilch","Joghurt",
  "Brot","Brötchen","Nudeln","Pasta","Reis","Quinoa","Kartoffeln",
  "Apfel","Banane","Beeren","Salat","Gurke","Paprika","Zucchini","Brokkoli","Karotten","Zwiebel","Knoblauch",
  "Olivenöl","Butter","Käse",
];

const DEFAULT_OFFER_WINDOW_MS = 7 * 24 * 3600 * 1000;

export function isCurrentlyValid(o: Offer, now: number): boolean {
  if (!o.validityDates || o.validityDates.length === 0) return true;
  return o.validityDates.some((d) => {
    const from = Date.parse(d.from);
    if (Number.isNaN(from)) return false;
    let until: number;
    const explicit = d.to ?? d.until;
    if (explicit) {
      const parsed = Date.parse(explicit);
      // Explicit date-only string parses to midnight; add end-of-day grace so an
      // offer "valid until 2025-05-31" stays valid through all of May 31.
      until = Number.isNaN(parsed) ? from + DEFAULT_OFFER_WINDOW_MS : parsed + 24 * 3600 * 1000;
    } else {
      // Default window is already an absolute 7-day moment — no extra grace.
      until = from + DEFAULT_OFFER_WINDOW_MS;
    }
    return from <= now && now <= until;
  });
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyFailure(error?: string): string {
  if (!error) return "unknown";
  const normalized = error.toLowerCase();
  if (/\b(401|403)\b/.test(normalized) || /\b(unauthorized|unauthenticated|forbidden)\b/.test(normalized) || /\bauth(?:entication|orization)?\s*(?:failure|failed|error|required)\b/.test(normalized)) {
    return "authentication";
  }
  if (normalized.includes("timeout") || normalized.includes("network") || normalized.includes("fetch failed") || /\beconn|enotfound|eai_again\b/.test(normalized)) {
    return "network";
  }
  if (normalized.includes("marktguru") || /\b5\d\d\b/.test(normalized) || /\b4\d\d\b/.test(normalized)) return "marktguru-api";
  return "unknown";
}

function summarizeFailureClasses(failures: WeeklyOfferTermOutcome[]): string {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const failureClass = failure.status === "error" ? classifyFailure(failure.error) : "unknown";
    counts.set(failureClass, (counts.get(failureClass) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([failureClass, count]) => `${failureClass}: ${count}`)
    .join(", ");
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

export async function getWeeklyOffers(zipCode: string, stores?: string[], terms?: string[], perTermLimit = 20): Promise<SearchResponse> {
  const queries = (terms && terms.length > 0) ? terms : DEFAULT_BASKET_TERMS;
  await getKeys();
  const settled = await allSettledWithConcurrency(queries, WEEKLY_OFFERS_CONCURRENCY, (term) =>
    searchOffers({ query: term, zipCode, stores, limit: perTermLimit }),
  );
  const outcomes: WeeklyOfferTermOutcome[] = settled.map((result, index) => {
    const term = queries[index]!;
    if (result.status === "fulfilled") return { term, status: "ok", results: result.value.results ?? [] };
    return { term, status: "error", error: stringifyError(result.reason), results: [] };
  });
  const failures = outcomes.filter((outcome): outcome is Extract<WeeklyOfferTermOutcome, { status: "error" }> => outcome.status === "error");
  const failureRatio = failures.length / queries.length;
  if (failureRatio >= 0.5) {
    const failedTerms = failures.map((failure) => failure.term);
    const sampleErrors = failures
      .slice(0, 3)
      .map((failure) => `${failure.term}: ${failure.error ?? "unknown error"}`)
      .join("; ");
    throw new Error(`getWeeklyOffers failed for ${failures.length}/${queries.length} terms (${Math.round(failureRatio * 100)}%). Failure classes: ${summarizeFailureClasses(failures)}. Failed terms: ${failedTerms.join(", ")}. Sample errors: ${sampleErrors}`);
  }
  const seen = new Set<number>();
  const merged: Offer[] = [];
  const now = Date.now();
  for (const outcome of outcomes) {
    if (outcome.status !== "ok") continue;
    for (const o of outcome.results) {
      if (seen.has(o.id)) continue;
      if (!isCurrentlyValid(o, now)) continue;
      seen.add(o.id);
      merged.push(o);
    }
  }
  const response: SearchResponse = { results: merged, totalResults: merged.length };
  if (failures.length > 0) {
    response.degraded = true;
    response.failedTerms = failures.map((failure) => failure.term);
  }
  return response;
}

export const HARDCODED_RETAILERS = [
  "aldi-nord",
  "aldi-sued",
  "lidl",
  "rewe",
  "edeka",
  "penny",
  "netto-marken-discount",
  "norma",
  "kaufland",
];

export async function listStores(zipCode = "81669"): Promise<Array<{ uniqueName: string; name: string; count?: number }>> {
  try {
    const probe = await searchOffers({ query: "milch", zipCode, limit: 50 });
    const slugByName = new Map<string, string>();
    for (const o of probe.results) {
      for (const a of o.advertisers ?? []) {
        if (a.name && a.uniqueName) slugByName.set(a.name, a.uniqueName);
      }
    }
    const facet = probe.filters?.retailers;
    if (facet && facet.length > 0) {
      return facet.map((f: { id?: number; name: string; resultsCount?: number; uniqueName?: string }) => ({
        uniqueName: f.uniqueName ?? slugByName.get(f.name) ?? f.name.toLowerCase().replace(/\s+/g, "-"),
        name: f.name,
        count: f.resultsCount,
      }));
    }
  } catch {}
  return HARDCODED_RETAILERS.map((u) => ({ uniqueName: u, name: u }));
}
