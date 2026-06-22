import { loadCookieHeader, setCookieOverride, getCachedToken, setCachedToken } from "./auth.ts";

// Locale config. COOKIDOO_LOCALE is a path locale like "de-DE", "en-GB", "fr-FR"
// (the {lang}-{COUNTRY} form Cookidoo puts in URL paths). LANG is the bare first
// segment ("de") used by the Algolia index and one bare-locale endpoint. Domain is
// looked up per country; unknown locales fall back to a cookidoo.<cc> guess.
// Verified mapping source: miaucl/cookidoo-api localization.json.
export const LOCALE = process.env.COOKIDOO_LOCALE?.trim() || "de-DE";
export const LANG = LOCALE.split("-")[0]!.toLowerCase();
const COUNTRY = (LOCALE.split("-")[1] || LANG).toLowerCase();

// Verified locale → domain pairs. Anything not listed falls back to cookidoo.<country>.
// cookidoo.international is the catch-all host for 34 countries without their own TLD;
// its locale codes use the synthetic "-INT" country (e.g. en-INT, es-INT) and, unlike
// country domains, put the BARE language in the URL path (/shopping/en not /shopping/en-INT).
// Source: miaucl/cookidoo-api localization.json + live cookidoo.international redirect (market=xp).
const DOMAINS: Record<string, string> = {
  "de-DE": "cookidoo.de",
  "en-GB": "cookidoo.co.uk",
  "fr-FR": "cookidoo.fr",
  "it-IT": "cookidoo.it",
  "es-ES": "cookidoo.es",
  "de-AT": "cookidoo.at",
  "de-CH": "cookidoo.ch",
  "fr-CH": "cookidoo.ch",
  "it-CH": "cookidoo.ch",
  "en-US": "cookidoo.thermomix.com",
  "en-AU": "cookidoo.com.au",
  "en-CA": "cookidoo.ca",
  "fr-CA": "cookidoo.ca",
  "nl-BE": "cookidoo.be",
  "es-MX": "cookidoo.mx",
  "pt-PT": "cookidoo.pt",
  "tr-TR": "cookidoo.com.tr",
};
const INTERNATIONAL_HOST = "cookidoo.international";
// "-INT" country (any language) maps to the shared international host.
const isInternational = COUNTRY === "int";
const DOMAIN = isInternational ? INTERNATIONAL_HOST : (DOMAINS[LOCALE] ?? `cookidoo.${COUNTRY}`);
export const BASE = `https://${DOMAIN}`;
// Path segment Cookidoo expects after the host. Country domains use the full {lang}-{COUNTRY}
// locale; the international host uses the bare language. Everything below builds URLs with
// PATH_LOCALE, never LOCALE directly.
export const PATH_LOCALE = isInternational ? LANG : LOCALE;
const ALGOLIA_APP_ID = "3TA8NT85XJ";
const ALGOLIA_HOST = "3ta8nt85xj-dsn.algolia.net";
// ponytail: non-DE Algolia index names are inferred (recipes-production-<lang>), not
// verified from source — the real name is returned by the token endpoint at runtime.
// Override with COOKIDOO_ALGOLIA_INDEX if the inferred name is wrong for your locale.
const ALGOLIA_INDEX = process.env.COOKIDOO_ALGOLIA_INDEX?.trim() || `recipes-production-${LANG}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_AUTH_RETRIES = 1;
const FETCH_TIMEOUT_MS = 15000;

// cachedToken lives in auth.ts's per-request store (getCachedToken/setCachedToken), NOT a module
// global here — see the F11-class note there. switchAccount clears the current chain's slot only.

interface SubscriptionTokenResponse {
  apiKey: string;
  validUntil: number;
  version: string;
  type: string;
  subscriptionLevel: "FULL" | "FREE" | string;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const redactedUrl = String(url).split("?")[0];
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${redactedUrl}`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function authedFetch(url: string, init: RequestInit = {}): Promise<{ response: Response; cookie: string }> {
  const cookie = await loadCookieHeader();
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("User-Agent", UA);
  headers.set("Accept-Language", `${PATH_LOCALE},${LANG};q=0.9`);
  const response = await fetchWithTimeout(url, { ...init, headers });
  return { response, cookie };
}

async function cookieChangedSince(prev: string | null): Promise<boolean> {
  if (!prev) return true;
  const current = await loadCookieHeader();
  return current !== prev;
}

// 401 = expired/missing cookie → retryable (a fresh re-auth changes the cookie file). 403 is
// DIFFERENT: the cookie is valid but the account lacks entitlement for this operation
// (e.g. custom-recipe creation is subscription-gated — confirmed live: NONE-tier GETs
// created-recipes fine but POST returns 403 "User is not authorized to access the resource").
// Folding 403 into the retry path mislabels a subscription gate as an auth failure AND
// retries a non-idempotent create — both wrong. Only 401 is an auth failure here.
function isAuthFailure(status: number): boolean {
  return status === 401;
}

function persistentAuthError(operation: string, status: number): Error {
  return new Error(
    `${operation} failed with persistent auth failure after ${MAX_AUTH_RETRIES} retry: ${status}. ` +
      "Cookie file unchanged between retries — re-authenticate Cookidoo, then run " +
      "`bun run src/import-state.ts <path-to-playwright-state.json>` to refresh stored cookies.",
  );
}

// 403 with a valid cookie = not an auth failure, do NOT retry, do NOT tell the user to
// re-authenticate (that won't grant a subscription). Surface the entitlement cause instead.
function forbiddenError(operation: string, body: string): Error {
  return new Error(
    `${operation} forbidden (403): account not authorized for this operation — it may lack the ` +
      `required Cookidoo subscription/entitlement (some writes, e.g. custom-recipe creation, are ` +
      `subscription-gated). ${body.slice(0, 200)}`,
  );
}

// Custom/created recipe ids are 26-char Crockford-base32 ULIDs; catalog ids are far shorter
// all-digit ints. Length is the discriminator used by both normalizeRecipeId and isCustomRecipeId.
const ULID_LENGTH = 26;

// Vorwerk catalog recipe ids are SHORT all-digit ints and the API wants them `r`-prefixed.
// Custom/created recipes are 26-char ULIDs and must be sent RAW — prefixing a ULID corrupts it.
// A ULID can be all-digits (Crockford base32 includes 0-9), so guard on length too: only prefix
// SHORT purely-numeric ids; leave anything with a letter (r-prefixed catalog OR ULID) or of
// ULID length untouched.
export function normalizeRecipeId(recipeId: string): string {
  return recipeId.length < ULID_LENGTH && /^\d+$/.test(recipeId) ? `r${recipeId}` : recipeId;
}

// Catalog-vs-custom classifier for migrate remapping. A Vorwerk catalog id is a SHORT all-digit
// integer, either bare (`12345`, bare-input form) OR already `r`-prefixed (`r12345`, the form
// reads return). A custom/created recipe is a 26-char Crockford-base32 ULID. Normally a ULID
// contains a letter so `\d+` wouldn't match — BUT a ULID can be all-digits (Crockford base32
// includes 0-9), and `r?\d+` matches an all-digit string of ANY length, so a 26-digit ULID would
// be misclassified as catalog and its ref written RAW into D (no-raw-ULID breach). Guard on
// LENGTH: a real catalog id is far shorter than a ULID's 26 chars, so only treat SHORT all-digit
// ids as catalog. NOTE: deliberately NOT the inverse of normalizeRecipeId (`/^\d+$/`), which
// misclassifies an already-prefixed `r12345` as custom. Cross-account refs are classified with
// THIS; only custom ids need IdMap translation, catalog ids pass through unchanged.
export function isCustomRecipeId(recipeId: string): boolean {
  if (recipeId.length >= ULID_LENGTH) return true; // ULID-length → custom, even if all-digit
  return !/^r?\d+$/.test(recipeId);
}

// `accept` defaults to application/json; pass a vendor media type for the organize
// custom-list/managed-list writes (content-negotiated — the wrong Accept can change the
// response body shape, e.g. drop the new list's id, which downstream callers depend on).
async function authedWrite(
  operation: string,
  method: string,
  url: string,
  body: unknown,
  referer = `${BASE}/`,
  accept = "application/json",
): Promise<unknown> {
  let prevCookie: string | null = null;
  for (let attempt = 0; attempt <= MAX_AUTH_RETRIES; attempt++) {
    if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
      throw persistentAuthError(operation, 401);
    }
    const { response: r, cookie } = await authedFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-requested-with": "xmlhttprequest",
        Referer: referer,
        Accept: accept,
      },
      body: JSON.stringify(body),
    });
    prevCookie = cookie;

    if (isAuthFailure(r.status)) {
      if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError(operation, r.status);
      continue;
    }

    // 403 = entitlement gate, not auth. Throw immediately (no retry of a non-idempotent write).
    if (r.status === 403) throw forbiddenError(operation, await r.text());

    if (r.status === 204) return { ok: true };

    const text = await r.text();
    if (!r.ok) throw new Error(`${operation} failed: ${r.status} ${text}`);
    if (!text.trim()) return { ok: true };

    try {
      return JSON.parse(text);
    } catch {
      return { ok: true };
    }
  }

  throw new Error(`${operation} failed unexpectedly`);
}

// Read-only GET with the same auth-retry contract as authedWrite: one retry, only
// if the cookie file changed between attempts (a fresh re-auth), else fail loud.
// `accept` defaults to application/json; pass a vendor media type for the
// organize custom-list/managed-list endpoints (content-negotiated, see Phase B docs).
async function authedRead(operation: string, url: string, accept = "application/json"): Promise<unknown> {
  let prevCookie: string | null = null;
  for (let attempt = 0; attempt <= MAX_AUTH_RETRIES; attempt++) {
    if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
      throw persistentAuthError(operation, 401);
    }
    const { response: r, cookie } = await authedFetch(url, { headers: { Accept: accept } });
    prevCookie = cookie;
    if (isAuthFailure(r.status)) {
      if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError(operation, r.status);
      continue;
    }
    if (r.status === 403) throw forbiddenError(operation, await r.text());
    if (!r.ok) throw new Error(`${operation} failed: ${r.status}`);
    return r.json();
  }
  throw new Error(`${operation} failed unexpectedly`);
}

// Walk a paginated organize endpoint to the end and concatenate items. Every Phase B
// list response carries page:{page,totalPages,totalElements}; fetching only page 0
// silently caps heavy accounts (mine is single-page, so a live probe can't catch it).
// `extract` pulls the items array + page meta out of one response body.
// ponytail: serial page walk — fine for organize lists (tens of pages at most);
// parallelize by totalPages if a list ever grows into the thousands.
async function fetchAllPages<T>(
  operation: string,
  buildUrl: (page: number) => string,
  accept: string,
  extract: (body: unknown) => { items: T[]; totalPages: number },
): Promise<T[]> {
  const all: T[] = [];
  let page = 0;
  // Latch totalPages from the FIRST page only. authedRead throws on non-2xx, so the bound
  // is set once from authoritative meta; a later page echoing a smaller totalPages can't
  // silently truncate the walk.
  let totalPages = 1;
  do {
    const body = await authedRead(operation, buildUrl(page), accept);
    const { items, totalPages: tp } = extract(body);
    all.push(...items);
    if (page === 0) totalPages = tp > 0 ? tp : 1;
    page++;
  } while (page < totalPages);
  return all;
}

interface PageMeta {
  page?: number;
  totalPages?: number;
  totalElements?: number;
}

// Point every subsequent read/write at a specific account's cookie (or null to
// restore the on-disk default). Clears cachedToken too — it is the previous
// account's subscription token; leaving it would let account D inherit A's entitlement.
// migrate_account calls this per source/target and resets to null in a finally.
export function switchAccount(cookieHeader: string | null): void {
  setCookieOverride(cookieHeader);
  setCachedToken(null);
}

export async function getSearchToken(force = false): Promise<{ apiKey: string; subscriptionLevel: string }> {
  const now = Math.floor(Date.now() / 1000);
  const cached = getCachedToken();
  if (!force && cached && cached.validUntil > now + 60) {
    return { apiKey: cached.apiKey, subscriptionLevel: cached.subscriptionLevel };
  }
  const { response: r } = await authedFetch(`${BASE}/search/api/subscription/token`);
  if (!r.ok) throw new Error(`cookidoo token endpoint failed: ${r.status} ${await r.text()}`);
  const json = (await r.json()) as SubscriptionTokenResponse;
  setCachedToken({ apiKey: json.apiKey, validUntil: json.validUntil, subscriptionLevel: json.subscriptionLevel });
  return { apiKey: json.apiKey, subscriptionLevel: json.subscriptionLevel };
}

// Coarse subscription level (e.g. "FULL" | "FREE" | "NONE" — "NONE" seen live for an
// account without an active plan), derived from the search token we
// already bootstrap — no extra request, no new endpoint. The richer
// GET /ownership/subscriptions (tier + expiry) is mobile-surface/inferred and
// deliberately NOT used here until verified on web+cookie (see docs/research).
export async function getSubscription(): Promise<{ subscriptionLevel: string }> {
  const { subscriptionLevel } = await getSearchToken();
  return { subscriptionLevel };
}

// Structured shopping-list read. GET /shopping/{LOCALE} with Accept: application/json
// returns JSON ({recipes, customerRecipes, additionalItems}) on the web+cookie surface
// — verified live 2026-06-21 (content negotiation; the default page nav returns SSR HTML).
// This is the enabling read for every shopping write and for migrate_account's copy side.
// The ingredient `id` here is likely the id mark_owned/unmark_owned operate on (corroborated
// by miaucl, which keys ownership edits off the same group id — but miaucl uses a different
// write endpoint than ours, so the match on our write path is inferred, not yet verified).
export interface ShoppingIngredient {
  id: string;
  isOwned: boolean;
  name?: string;
  quantity?: number;
  unit?: string;
  optional?: boolean;
  category?: string;
  recipeId?: string;
  recipeTitle?: string;
}

export interface ShoppingList {
  recipeCount: number;
  ingredients: ShoppingIngredient[];
  additionalItems: Array<{ id?: string; name?: string; isOwned?: boolean; [k: string]: unknown }>;
  raw: unknown;
}

interface ShoppingRecipeRaw {
  id?: string;
  title?: string;
  recipeIngredientGroups?: Array<{
    id?: string;
    isOwned?: boolean;
    optional?: boolean;
    ingredientNotation?: string;
    unitNotation?: string;
    quantity?: { value?: number };
    shoppingCategory_ref?: string;
  }>;
}

function flattenShoppingRecipe(r: ShoppingRecipeRaw): ShoppingIngredient[] {
  const groups = Array.isArray(r.recipeIngredientGroups) ? r.recipeIngredientGroups : [];
  return groups
    .filter((g) => g.id)
    .map((g) => ({
      id: g.id!,
      isOwned: Boolean(g.isOwned),
      name: g.ingredientNotation,
      quantity: g.quantity?.value,
      unit: g.unitNotation,
      optional: g.optional,
      category: g.shoppingCategory_ref,
      recipeId: r.id,
      recipeTitle: r.title,
    }));
}

export async function getShoppingList(attempt = 0, prevCookie: string | null = null): Promise<ShoppingList> {
  if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
    throw persistentAuthError("shopping list fetch", 401);
  }
  const { response: r, cookie } = await authedFetch(`${BASE}/shopping/${PATH_LOCALE}`, {
    headers: { Accept: "application/json" },
  });
  if (isAuthFailure(r.status)) {
    if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError("shopping list fetch", r.status);
    return getShoppingList(attempt + 1, cookie);
  }
  if (!r.ok) throw new Error(`shopping list fetch failed: ${r.status}`);
  const data = (await r.json()) as {
    recipes?: ShoppingRecipeRaw[];
    customerRecipes?: ShoppingRecipeRaw[];
    additionalItems?: ShoppingList["additionalItems"];
  };
  const recipes = [...(data.recipes ?? []), ...(data.customerRecipes ?? [])];
  return {
    recipeCount: recipes.length,
    ingredients: recipes.flatMap(flattenShoppingRecipe),
    additionalItems: Array.isArray(data.additionalItems) ? data.additionalItems : [],
    raw: data,
  };
}

export interface RecipeHit {
  id: string;
  title: string;
  image?: string;
  rating?: number;
  numberOfRatings?: number;
  totalTime?: number;
  category?: string[];
  publishedAt?: number;
  description?: string;
  url?: string;
}

export async function searchRecipes(query: string, hitsPerPage = 20, attempt = 0): Promise<RecipeHit[]> {
  if (!query || !query.trim()) {
    throw new Error("query is required and must be non-empty. For a random recipe use the random_recipe tool.");
  }
  return algoliaQuery({ query, hitsPerPage, page: 0, attempt });
}

interface AlgoliaQueryOpts {
  query: string;
  hitsPerPage: number;
  page: number;
  attempt: number;
}

async function algoliaQuery({ query, hitsPerPage, page, attempt }: AlgoliaQueryOpts): Promise<RecipeHit[]> {
  const { apiKey } = await getSearchToken(attempt > 0);
  const url = new URL(`https://${ALGOLIA_HOST}/1/indexes/*/queries`);
  url.searchParams.set("x-algolia-agent", "cookidoo-mcp/0.1");
  const body = {
    requests: [
      {
        indexName: ALGOLIA_INDEX,
        params: `query=${encodeURIComponent(query)}&hitsPerPage=${hitsPerPage}&page=${page}`,
      },
    ],
  };
  const r = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "x-algolia-api-key": apiKey,
      "x-algolia-application-id": ALGOLIA_APP_ID,
    },
    body: JSON.stringify(body),
  });
  if (isAuthFailure(r.status)) {
    if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError("algolia search", r.status);
    return algoliaQuery({ query, hitsPerPage, page, attempt: attempt + 1 });
  }
  if (!r.ok) throw new Error(`algolia search failed: ${r.status} ${await r.text()}`);
  const json = (await r.json()) as { results: Array<{ hits: RecipeHit[]; nbPages?: number }> };
  return json.results[0]?.hits ?? [];
}

const RANDOM_RECIPE_TERMS = [
  "Pasta", "Reis", "Suppe", "Salat", "Curry", "Risotto", "Auflauf",
  "Pancakes", "Smoothie", "Brot", "Kuchen", "Quiche", "Pizza",
  "Eintopf", "Wok", "Bowl", "Wrap", "Dip", "Sauce", "Frühstück",
];

export async function randomRecipe(category?: string): Promise<RecipeHit> {
  const seed = category ?? RANDOM_RECIPE_TERMS[Math.floor(Math.random() * RANDOM_RECIPE_TERMS.length)]!;
  const page = Math.floor(Math.random() * 10);
  const hits = await algoliaQuery({ query: seed, hitsPerPage: 20, page, attempt: 0 });
  if (hits.length === 0) {
    const fallback = await algoliaQuery({ query: seed, hitsPerPage: 20, page: 0, attempt: 0 });
    if (fallback.length === 0) throw new Error(`random_recipe: no results for seed "${seed}"`);
    return fallback[Math.floor(Math.random() * fallback.length)]!;
  }
  return hits[Math.floor(Math.random() * hits.length)]!;
}

export interface RecipeDetail {
  id: string;
  url: string;
  title: string;
  image?: string;
  description?: string;
  totalTime?: string;
  cookTime?: string;
  prepTime?: string;
  yield?: string;
  category?: string[];
  ingredients: string[];
  instructions: string[];
  rating?: number;
  reviewCount?: number;
  // schema.org NutritionInformation block (calories, fatContent, etc.). Absent on
  // many recipes — passed through verbatim, undefined when the JSON-LD omits it.
  nutrition?: Record<string, unknown>;
  raw?: unknown;
}

function parseIsoDuration(d?: string): number | undefined {
  if (!d) return undefined;
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return undefined;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]!));
    } catch {}
  }
  return blocks;
}

export async function getRecipe(id: string, attempt = 0, prevCookie: string | null = null): Promise<RecipeDetail> {
  const recipeId = normalizeRecipeId(id);
  const url = `${BASE}/recipes/recipe/${PATH_LOCALE}/${recipeId}`;
  if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
    throw persistentAuthError("recipe fetch", 401);
  }
  const { response: r, cookie } = await authedFetch(url);
  if (isAuthFailure(r.status)) {
    if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError("recipe fetch", r.status);
    return getRecipe(id, attempt + 1, cookie);
  }
  if (!r.ok) throw new Error(`recipe fetch failed: ${r.status}`);
  const html = await r.text();
  const blocks = extractJsonLdBlocks(html);
  const recipeBlock = blocks.find((b: any) => b?.["@type"] === "Recipe") as any;
  const ratingBlock = blocks.find((b: any) => b?.["@type"] === "AggregateRating") as any;
  if (!recipeBlock) throw new Error(`no Recipe JSON-LD found at ${url}`);
  const ingredients: string[] = Array.isArray(recipeBlock.recipeIngredient) ? recipeBlock.recipeIngredient.map((s: string) => s.trim()) : [];
  const instr = recipeBlock.recipeInstructions;
  const instructions: string[] = Array.isArray(instr)
    ? instr.map((i: any) => (typeof i === "string" ? i : i?.text ?? "")).filter(Boolean)
    : typeof instr === "string"
    ? [instr]
    : [];
  return {
    id: recipeId,
    url,
    title: recipeBlock.name,
    image: typeof recipeBlock.image === "string" ? recipeBlock.image : recipeBlock.image?.url,
    description: recipeBlock.description,
    totalTime: recipeBlock.totalTime,
    cookTime: recipeBlock.cookTime,
    prepTime: recipeBlock.prepTime,
    yield: recipeBlock.recipeYield,
    category: Array.isArray(recipeBlock.recipeCategory) ? recipeBlock.recipeCategory : recipeBlock.recipeCategory ? [recipeBlock.recipeCategory] : undefined,
    ingredients,
    instructions,
    rating: ratingBlock?.ratingValue,
    reviewCount: ratingBlock?.reviewCount,
    nutrition: recipeBlock.nutrition && typeof recipeBlock.nutrition === "object" ? recipeBlock.nutrition : undefined,
  };
}

export interface PlannedRecipe {
  id?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

export interface DayPlan {
  date: string;
  recipes: PlannedRecipe[];
  recipeIds?: string[];
  // Custom (CUSTOMER-source) recipes come back in a SEPARATE top-level array of bare ULIDs,
  // never in `recipes`/`recipeIds`. Confirmed live: a custom-only day has recipeIds:[] recipes:[]
  // and customerRecipeIds:["<ULID>"]. Dropping this is what made the IdMap custom-ref remap
  // unreachable from live data.
  customerRecipeIds?: string[];
  recipeCount?: number;
}

export interface WeekPlan {
  dayKeys: DayPlan[];
}

interface PlannedRecipesResponse {
  dayKeys: string[];
}

interface MyDayResponse {
  recipes?: PlannedRecipe[];
  recipeIds?: string[];
  customerRecipeIds?: string[];
  recipeCount?: number;
  [key: string]: unknown;
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getCurrentWeekMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + offset);
  return localISODate(monday);
}

export async function getDayPlan(dayKey: string, attempt = 0, prevCookie: string | null = null): Promise<DayPlan> {
  if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
    throw persistentAuthError("day plan fetch", 401);
  }
  const { response: r, cookie } = await authedFetch(`${BASE}/planning/${PATH_LOCALE}/api/my-day/${encodeURIComponent(dayKey)}`);
  if (isAuthFailure(r.status)) {
    if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError("day plan fetch", r.status);
    return getDayPlan(dayKey, attempt + 1, cookie);
  }
  if (!r.ok) throw new Error(`day plan fetch failed: ${r.status}`);
  const data = (await r.json()) as MyDayResponse;
  return {
    date: dayKey,
    recipes: Array.isArray(data.recipes) ? data.recipes : [],
    recipeIds: Array.isArray(data.recipeIds) ? data.recipeIds : undefined,
    customerRecipeIds: Array.isArray(data.customerRecipeIds) ? data.customerRecipeIds : undefined,
    recipeCount: typeof data.recipeCount === "number" ? data.recipeCount : undefined,
  };
}

export async function getWeekPlan(startDate?: string, span = 7, attempt = 0, prevCookie: string | null = null): Promise<WeekPlan> {
  const date = startDate ?? getCurrentWeekMonday();
  if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
    throw persistentAuthError("week plan fetch", 401);
  }
  const { response: r, cookie } = await authedFetch(`${BASE}/planning/${PATH_LOCALE}/api/my-day/planned-recipes/${date}?span=${span}`);
  if (isAuthFailure(r.status)) {
    if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError("week plan fetch", r.status);
    return getWeekPlan(startDate, span, attempt + 1, cookie);
  }
  if (!r.ok) throw new Error(`week plan fetch failed: ${r.status}`);
  const raw = (await r.json()) as PlannedRecipesResponse;
  const dayKeys = Array.isArray(raw.dayKeys) ? raw.dayKeys : [];
  const settled = await Promise.allSettled(dayKeys.map((k) => getDayPlan(k)));
  const days: DayPlan[] = [];
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      days.push(result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${dayKeys[i]}: ${reason}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `week plan fetch: ${failures.length} day(s) failed to load, refusing to return a partial plan ` +
        `(a snapshot built on incomplete data could delete recipes): ${failures.join("; ")}`,
    );
  }
  return { dayKeys: days };
}

export async function addToWeek(
  recipeIds: string[],
  dayKey: string,
  options: { force?: boolean; recipeSource?: string } = {},
): Promise<{ added: string[]; skipped: string[] }> {
  // recipeSource defaults to VORWERK (catalog). Custom/created recipes need a different
  // source value in the PUT body; migrate passes it explicitly per source-group. The body
  // carries ONE recipeSource for the whole recipeIds batch, so a mixed catalog+custom set
  // must be split into two addToWeek calls by the caller.
  const recipeSource = options.recipeSource ?? "VORWERK";
  const normalizedIds = [...new Set(recipeIds.map(normalizeRecipeId))];
  let toAdd = normalizedIds;
  const skipped: string[] = [];

  if (!options.force) {
    try {
      const day = await getDayPlan(dayKey);
      const existing = new Set<string>();
      for (const r of day.recipes) {
        const id = r.id ?? (typeof r.recipeId === "string" ? (r.recipeId as string) : undefined);
        if (id) existing.add(normalizeRecipeId(id));
      }
      for (const id of day.recipeIds ?? []) existing.add(normalizeRecipeId(id));
      for (const id of day.customerRecipeIds ?? []) existing.add(normalizeRecipeId(id));

      toAdd = [];
      for (const id of normalizedIds) {
        if (existing.has(id)) skipped.push(id);
        else toAdd.push(id);
      }
    } catch (e) {
      // 404 = empty day (my-day returns 404+E004 "Day is not found" for a day with zero recipes,
      // distinct from 400 on a malformed date). Nothing to dedupe against → add all. Any other
      // failure (500, auth, etc.) still aborts: a silent add on an unknown read error risks dupes.
      const empty404 = e instanceof Error && /day plan fetch failed: 404/.test(e.message);
      if (!empty404) {
        throw new Error(
          `add to week: could not read day plan ${dayKey} for dedupe check: ${e instanceof Error ? e.message : String(e)}. ` +
            "Pass force:true to skip the dedupe read and add unconditionally.",
        );
      }
      // empty day: toAdd stays = normalizedIds, skipped stays = []
    }
  }

  if (toAdd.length === 0) {
    return { added: [], skipped };
  }

  await authedWrite("add to week", "PUT", `${BASE}/planning/${PATH_LOCALE}/api/my-day`, {
    _method: "put",
    recipeSource,
    recipeIds: toAdd,
    dayKey,
  });
  return { added: toAdd, skipped };
}

export async function removeFromWeek(recipeId: string, dayKey: string): Promise<unknown> {
  const normalizedId = normalizeRecipeId(recipeId);
  const encodedDayKey = encodeURIComponent(dayKey);
  const encodedRecipeId = encodeURIComponent(normalizedId);
  // Source must match how it was added: customs (CUSTOMER) won't be found under VORWERK and the
  // DELETE no-ops. Auto-detect from the id form so callers (clearWeek, MCP tool) need no extra arg.
  const recipeSource = isCustomRecipeId(normalizedId) ? "CUSTOMER" : "VORWERK";
  return authedWrite(
    "remove from week",
    "DELETE",
    `${BASE}/planning/${PATH_LOCALE}/api/my-day/${encodedDayKey}/recipes/${encodedRecipeId}?recipeSource=${recipeSource}`,
    {
      _method: "delete",
      dayKey,
      recipeId: normalizedId,
      recipeSource,
    },
  );
}

export async function clearWeek(
  startDate?: string,
  span?: number,
): Promise<{ removed: number; errors: Array<{ dayKey: string; recipeId: string; error: string }> }> {
  const plan = await getWeekPlan(startDate, span ?? 7);
  let removed = 0;
  const errors: Array<{ dayKey: string; recipeId: string; error: string }> = [];

  for (const day of plan.dayKeys) {
    const ids = [
      ...day.recipes
        .map((recipe) => recipe.id ?? (typeof recipe.recipeId === "string" ? recipe.recipeId : undefined))
        .filter((id): id is string => Boolean(id)),
      ...(day.customerRecipeIds ?? []),
    ];
    for (const recipeId of ids) {
      try {
        await removeFromWeek(recipeId, day.date);
        removed++;
      } catch (e) {
        errors.push({
          dayKey: day.date,
          recipeId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { removed, errors };
}

export async function addToShoppingList(recipeIds: string[]): Promise<unknown> {
  return authedWrite("add to shopping list", "POST", `${BASE}/shopping/${PATH_LOCALE}/add-recipes`, {
    recipeIDs: recipeIds.map(normalizeRecipeId),
  });
}

export async function markOwned(ingredientIds: string[]): Promise<unknown> {
  return authedWrite("mark owned", "POST", `${BASE}/shopping/${PATH_LOCALE}/owned-ingredients`, {
    ingredientIDS: ingredientIds,
  });
}

export async function unmarkOwned(ingredientId: string): Promise<unknown> {
  // NB: this endpoint uses the bare lang segment ("de"), not the full locale ("de-DE"),
  // unlike markOwned above. Preserved as-is — behavior-preserving for the de-DE default.
  return authedWrite("unmark owned", "DELETE", `${BASE}/shopping/${LANG}/owned-ingredients/${encodeURIComponent(ingredientId)}`, {
    _method: "delete",
  });
}

// --- Phase C shopping writes (additional items + recipe ingredients) ----------
// All POST, full locale. Paths/bodies from miaucl/cookidoo-api (same web+cookie
// surface). additional-items add/remove round-trip verified live 2026-06-21 on the
// lapsed acct (200/204) — shopping is NOT subscription-gated. edit/ownership/recipes
// share the identical contract and surface; built to the lib's shapes.

// 7a — POST shopping/{lang}/additional-items/add  body {itemsValue:[...]} (is_owned forced false)
export async function addAdditionalItems(items: string[]): Promise<unknown> {
  return authedWrite("add additional items", "POST", `${BASE}/shopping/${PATH_LOCALE}/additional-items/add`, {
    itemsValue: items,
  });
}

// 7b — POST shopping/{lang}/additional-items/edit  body {additionalItems:[{id,name}]}
export async function editAdditionalItems(items: Array<{ id: string; name: string }>): Promise<unknown> {
  return authedWrite("edit additional items", "POST", `${BASE}/shopping/${PATH_LOCALE}/additional-items/edit`, {
    additionalItems: items,
  });
}

// 7c — POST shopping/{lang}/additional-items/remove  body {additionalItemIDs:[...]} (POST, not DELETE)
export async function removeAdditionalItems(ids: string[]): Promise<unknown> {
  return authedWrite("remove additional items", "POST", `${BASE}/shopping/${PATH_LOCALE}/additional-items/remove`, {
    additionalItemIDs: ids,
  });
}

// 7d — POST shopping/{lang}/additional-items/ownership/edit
// body {additionalItems:[{id,isOwned,ownedTimestamp}]}. Timestamp is unix SECONDS; default
// to now when marking owned (mirrors what the UI sends), omit-as-0 when un-owning.
export async function editAdditionalItemOwnership(
  items: Array<{ id: string; isOwned: boolean; ownedTimestamp?: number }>,
): Promise<unknown> {
  const withTs = items.map((it) => ({
    id: it.id,
    isOwned: it.isOwned,
    ownedTimestamp: it.ownedTimestamp ?? (it.isOwned ? Math.floor(Date.now() / 1000) : 0),
  }));
  return authedWrite("edit additional item ownership", "POST", `${BASE}/shopping/${PATH_LOCALE}/additional-items/ownership/edit`, {
    additionalItems: withTs,
  });
}

// 7g — POST shopping/{lang}/owned-ingredients/ownership/edit body {ingredients:[{id,isOwned,ownedTimestamp}]}.
// Bulk-toggle owned-state for RECIPE-derived ingredients (key `ingredients` — contrast 7d's
// `additionalItems`). Same timestamp rule as 7d. Batch sibling of mark/unmarkOwned (single id).
// (Not used by migrate — owned-state is ephemeral shopping state, not migratable content.)
export async function editOwnedIngredients(
  items: Array<{ id: string; isOwned: boolean; ownedTimestamp?: number }>,
): Promise<unknown> {
  const withTs = items.map((it) => ({
    id: it.id,
    isOwned: it.isOwned,
    ownedTimestamp: it.ownedTimestamp ?? (it.isOwned ? Math.floor(Date.now() / 1000) : 0),
  }));
  return authedWrite("edit owned ingredients", "POST", `${BASE}/shopping/${PATH_LOCALE}/owned-ingredients/ownership/edit`, {
    ingredients: withTs,
  });
}

// 7e — POST shopping/{lang}/recipes/add  body {recipeIDs:[...]} (CAPITAL IDs — shopping casing trap).
// Distinct from addToShoppingList (POST .../add-recipes): this is the lib's recipes/add endpoint.
// Vorwerk recipes pass bare ids; custom recipes pass {id,source:"CUSTOMER"} objects (source param).
export async function addRecipeIngredients(
  recipeIds: string[],
  source: "VORWERK" | "CUSTOMER" = "VORWERK",
): Promise<unknown> {
  // CUSTOMER ids are ULIDs → normalizeRecipeId leaves them raw (ULID-safe). VORWERK ids are
  // numeric → get the `r` prefix. Same call is correct for both because normalize only prefixes
  // all-digit ids.
  const ids =
    source === "CUSTOMER"
      ? recipeIds.map((id) => ({ id: normalizeRecipeId(id), source: "CUSTOMER" }))
      : recipeIds.map(normalizeRecipeId);
  return authedWrite("add recipe ingredients", "POST", `${BASE}/shopping/${PATH_LOCALE}/recipes/add`, {
    recipeIDs: ids,
  });
}

// 7f — POST shopping/{lang}/recipes/remove  body {recipeIDs:[...]} (CAPITAL IDs) → 200/204
export async function removeRecipeIngredients(recipeIds: string[]): Promise<unknown> {
  return authedWrite("remove recipe ingredients", "POST", `${BASE}/shopping/${PATH_LOCALE}/recipes/remove`, {
    recipeIDs: recipeIds.map(normalizeRecipeId),
  });
}

export async function bookmarkRecipe(recipeId: string): Promise<unknown> {
  return authedWrite("bookmark recipe", "PUT", `${BASE}/organize/${PATH_LOCALE}/api/bookmark`, {
    recipeId: normalizeRecipeId(recipeId),
  });
}

export async function unbookmarkRecipe(recipeId: string): Promise<unknown> {
  return authedWrite("unbookmark recipe", "DELETE", `${BASE}/organize/${PATH_LOCALE}/api/bookmark`, {
    recipeId: normalizeRecipeId(recipeId),
  });
}

// --- Phase B reads (read-only enumerations, low ban-risk) --------------------
// All endpoints verified live 2026-06-21 on the web+cookie surface (survey hard rule).
// Paths pinned from miaucl/cookidoo-api, which uses the same web surface we do.

export interface Bookmark {
  id: string; // FAV-... bookmark id (distinct from the recipe id)
  recipeId: string; // r... recipe id — what bookmarkRecipe/unbookmarkRecipe operate on
  title?: string;
  image?: string;
  prepTime?: string; // seconds-as-string, e.g. "900.0", passed through verbatim
  locale?: string;
}

interface BookmarkRaw {
  id?: string;
  recipe?: { id?: string; asciiTitle?: string; landscapeImage?: string; prepTime?: string; locale?: string };
}

// GET /organize/{LOCALE}/api/bookmark — plain JSON, paginated ({bookmarks,page}).
export async function getBookmarks(): Promise<Bookmark[]> {
  return fetchAllPages<Bookmark>(
    "bookmarks fetch",
    (page) => `${BASE}/organize/${PATH_LOCALE}/api/bookmark?page=${page}`,
    "application/json",
    (body) => {
      const b = body as { bookmarks?: BookmarkRaw[]; page?: PageMeta };
      const items = (b.bookmarks ?? [])
        .filter((x) => x.recipe?.id)
        .map((x) => ({
          id: x.id ?? "",
          recipeId: x.recipe!.id!,
          title: x.recipe!.asciiTitle,
          image: x.recipe!.landscapeImage,
          prepTime: x.recipe!.prepTime,
          locale: x.recipe!.locale,
        }));
      return { items, totalPages: b.page?.totalPages ?? 1 };
    },
  );
}

export interface Collection {
  id: string;
  title?: string;
  listType: string; // "CUSTOMLIST" (user-made, copyable) | "MANAGEDLIST" (Vorwerk, follow-only)
  author?: string;
  shared?: boolean;
  recipeCount: number;
}

interface CollectionRaw {
  id?: string;
  title?: string;
  listType?: string;
  author?: string;
  shared?: boolean;
  chapters?: Array<{ recipes?: unknown[] }>;
}

function countCollectionRecipes(c: CollectionRaw): number {
  return (c.chapters ?? []).reduce((n, ch) => n + (Array.isArray(ch.recipes) ? ch.recipes.length : 0), 0);
}

function mapCollection(c: CollectionRaw, fallbackType: string): Collection {
  return {
    id: c.id ?? "",
    title: c.title,
    listType: c.listType ?? fallbackType,
    author: c.author,
    shared: c.shared,
    recipeCount: countCollectionRecipes(c),
  };
}

// GET /organize/{LOCALE}/api/custom-list + .../managed-list — both need a vendor Accept
// media type and both paginate. Merged into one list tagged by listType (mirrors the
// shopping-list recipes+customerRecipes merge). The LIST view inlines chapters[].recipes
// (live-verified with the vendor mobile Accept), so recipeCount sums those; there is no
// dedicated count field, summing inlined chapters is the only source.
export async function getCollections(): Promise<Collection[]> {
  const custom = await fetchAllPages<Collection>(
    "custom-list fetch",
    (page) => `${BASE}/organize/${PATH_LOCALE}/api/custom-list?page=${page}`,
    "application/vnd.vorwerk.organize.custom-list.mobile+json",
    (body) => {
      const b = body as { customlists?: CollectionRaw[]; page?: PageMeta };
      return { items: (b.customlists ?? []).map((c) => mapCollection(c, "CUSTOMLIST")), totalPages: b.page?.totalPages ?? 1 };
    },
  );
  const managed = await fetchAllPages<Collection>(
    "managed-list fetch",
    (page) => `${BASE}/organize/${PATH_LOCALE}/api/managed-list?page=${page}`,
    "application/vnd.vorwerk.organize.managed-list.mobile+json",
    (body) => {
      const b = body as { managedlists?: CollectionRaw[]; page?: PageMeta };
      return { items: (b.managedlists ?? []).map((c) => mapCollection(c, "MANAGEDLIST")), totalPages: b.page?.totalPages ?? 1 };
    },
  );
  return [...custom, ...managed];
}

// --- Phase C collection writes (create / delete / membership) -----------------
// organize custom-list surface. create/delete need the vendor mobile Accept (same as
// the read). Membership add (10a) is a BLIND PUT that REPLACES the list — so we
// GET-merge-PUT: read existing recipe ids, union with the new ones, PUT the full set.
// The lib does a blind PUT (cookidoo.py) and would clobber; we must not.
const CUSTOM_LIST_ACCEPT = "application/vnd.vorwerk.organize.custom-list.mobile+json";

// GET one custom list with its recipe ids. The list body inlines chapters[].recipes[].id
// (same shape getCollections sums for recipeCount). Returns the flat id set + raw body.
//
// SAFETY (load-bearing): addRecipesToCollection blind-PUTs (existing ∪ new), so an empty
// `recipeIds` here means "PUT only the new ids" = WIPE every prior member. The single-GET
// `/custom-list/{id}` shape is NOT yet live-verified (assumed from the LIST endpoint), so we
// FAIL LOUD on the two ways the assumption can break instead of silently returning []:
//   1. body has no `chapters` array at all → shape is wrong, refuse (a genuinely empty
//      collection still returns `chapters: [...]`, just with empty `recipes`).
//   2. body paginates (page.totalPages > 1) → we'd only see page 1, dropping the tail → refuse.
// This downgrades "silent destructive wipe" to "loud error"; it does NOT make the wrong shape
// safe (recipes under a different key still parse to []). Live GET confirmation still gated
// (task #2). Remove these guards once the shape is verified.
export async function getCollection(id: string): Promise<{ id: string; title?: string; recipeIds: string[]; raw: unknown }> {
  const body = (await authedRead(
    "collection fetch",
    `${BASE}/organize/${PATH_LOCALE}/api/custom-list/${encodeURIComponent(id)}`,
    CUSTOM_LIST_ACCEPT,
  )) as {
    id?: string;
    title?: string;
    chapters?: Array<{ recipes?: Array<{ id?: string }> }>;
    page?: { totalPages?: number };
  };
  if (!Array.isArray(body.chapters)) {
    throw new Error(
      `getCollection(${id}): response has no \`chapters\` array — the assumed custom-list shape is ` +
        `wrong for this endpoint. Refusing to proceed (a blind PUT off a misparsed body would wipe the ` +
        `collection). Live-verify the single-GET shape before using collection writes.`,
    );
  }
  if ((body.page?.totalPages ?? 1) > 1) {
    throw new Error(
      `getCollection(${id}): response is paginated (totalPages=${body.page?.totalPages}) but only page 1 ` +
        `was fetched — a blind PUT would drop un-fetched members. Refusing. Add full-page fetching first.`,
    );
  }
  const recipeIds: string[] = [];
  for (const ch of body.chapters) {
    for (const rec of ch.recipes ?? []) {
      if (rec.id) recipeIds.push(rec.id);
    }
  }
  return { id: body.id ?? id, title: body.title, recipeIds, raw: body };
}

// 9a — POST organize/{lang}/api/custom-list  body {title} + vendor Accept → 200, content (new list).
export async function createCollection(title: string): Promise<{ id: string; title?: string; raw: unknown }> {
  const body = (await authedWrite(
    "create collection",
    "POST",
    `${BASE}/organize/${PATH_LOCALE}/api/custom-list`,
    { title },
    `${BASE}/organize/${PATH_LOCALE}`,
    CUSTOM_LIST_ACCEPT,
  )) as { id?: string; title?: string; content?: { id?: string; title?: string } };
  // International (cookidoo.international) wraps the created list as {message, content:{id,...}, code};
  // country domains return id at top level. Accept either shape. A missing id (content-negotiation
  // body surprise) must still fail loud here, not flow into addRecipesToCollection as an empty path.
  const id = body.id ?? body.content?.id;
  const title2 = body.title ?? body.content?.title;
  if (!id) throw new Error(`create collection: no id in response: ${JSON.stringify(body).slice(0, 200)}`);
  return { id, title: title2, raw: body };
}

// 9c — DELETE organize/{lang}/api/custom-list/{id} + vendor Accept → 200/204
export async function deleteCollection(id: string): Promise<unknown> {
  return authedWrite(
    "delete collection",
    "DELETE",
    `${BASE}/organize/${PATH_LOCALE}/api/custom-list/${encodeURIComponent(id)}`,
    { _method: "delete" },
    `${BASE}/organize/${PATH_LOCALE}`,
    CUSTOM_LIST_ACCEPT,
  );
}

// 10a — add recipes to a collection. PUT organize/{lang}/api/custom-list/{id} REPLACES the
// whole membership (blind PUT), so GET-merge-PUT: union existing + new, PUT the full set.
// recipeIds is LOWERCASE here (collection casing trap — contrast shopping's recipeIDs).
// Returns what was added vs already-present. For migrate A+B+C→D, call once per source OR
// pass the accumulated union — either is safe because we always re-read and union first.
export async function addRecipesToCollection(
  id: string,
  recipeIds: string[],
): Promise<{ added: string[]; alreadyPresent: string[]; total: number }> {
  const wanted = [...new Set(recipeIds.map(normalizeRecipeId))];
  const current = await getCollection(id);
  // Union RAW server ids with normalized wanted — never re-normalize ids the server gave us
  // (a ULID member would be corrupted by an `r` prefix). normalizeRecipeId is now ULID-safe,
  // but unioning raw keeps the existing members byte-identical to what the server stores.
  const existing = new Set(current.recipeIds);
  const added = wanted.filter((r) => !existing.has(r));
  const alreadyPresent = wanted.filter((r) => existing.has(r));
  if (added.length === 0) {
    return { added: [], alreadyPresent, total: existing.size };
  }
  const fullSet = [...new Set([...current.recipeIds, ...wanted])];
  // 10a: NO vendor Accept (spec) — defaults to application/json. The PUT response body is
  // discarded (we return locally-computed counts), so content negotiation can't corrupt us.
  await authedWrite(
    "add recipes to collection",
    "PUT",
    `${BASE}/organize/${PATH_LOCALE}/api/custom-list/${encodeURIComponent(id)}`,
    { recipeIds: fullSet },
    `${BASE}/organize/${PATH_LOCALE}`,
  );
  return { added, alreadyPresent, total: fullSet.length };
}

// 10b — DELETE organize/{lang}/api/custom-list/{id}/recipes/{recipe} → 200 with body. No vendor Accept.
export async function removeRecipeFromCollection(id: string, recipeId: string): Promise<unknown> {
  const rid = normalizeRecipeId(recipeId);
  return authedWrite(
    "remove recipe from collection",
    "DELETE",
    `${BASE}/organize/${PATH_LOCALE}/api/custom-list/${encodeURIComponent(id)}/recipes/${encodeURIComponent(rid)}`,
    { _method: "delete" },
    `${BASE}/organize/${PATH_LOCALE}`,
  );
}

export interface CustomRecipe {
  id: string; // ULID recipeId
  name?: string;
  status?: string; // ACTIVE | ...
  workStatus?: string; // PRIVATE | ...
  modifiedAt?: string;
  createdAt?: string;
  image?: string;
}

interface CustomRecipeRaw {
  recipeId?: string;
  status?: string;
  workStatus?: string;
  modifiedAt?: string;
  createdAt?: string;
  recipeContent?: { name?: string; image?: string };
}

// GET /created-recipes/{LOCALE} — the account's own (user-authored) recipes.
// Plain JSON, NOT paginated: returns {items,meta} in one shot, no `page` block; the
// `?page=` param is ignored (live-verified — every page returns the full set). meta
// carries recipeLimit info only (no total), so a single request is the full list.
export async function getCustomRecipes(): Promise<CustomRecipe[]> {
  const body = (await authedRead("custom recipes fetch", `${BASE}/created-recipes/${PATH_LOCALE}`)) as {
    items?: CustomRecipeRaw[];
  };
  return (body.items ?? []).map((x) => ({
    id: x.recipeId ?? "",
    name: x.recipeContent?.name,
    status: x.status,
    workStatus: x.workStatus,
    modifiedAt: x.modifiedAt,
    createdAt: x.createdAt,
    image: x.recipeContent?.image,
  }));
}

// GET /created-recipes/{LOCALE}/{id} — full content of ONE authored recipe. Same resource
// PATCH targets (CookidooClient.py uses that path for every edit), so GET on it returns the
// full object. getCustomRecipes (list) returns only id/name/status/image — this fills the rest
// (ingredients/instructions/hints/tools/time/yield) so migrate's pass-1 can recreate a recipe in D.
//
// LIVE-VERIFIED (.international, 2026-06-21, FULL/TRIAL account): GET nests all content under
// `recipeContent` with schema.org keys (recipeIngredient/recipeInstructions as plain strings,
// `tool`, `recipeYield{value,unitText}`, times as ISO-8601). asTextList stays tolerant of the
// {type,text} write shape too, in case a future locale returns objects.
function asTextList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string") {
        return (x as { text: string }).text;
      }
      return "";
    })
    .filter((s) => s.length > 0);
  return out.length ? out : undefined;
}

export interface CustomRecipeDetail extends CustomRecipeInput {
  id: string; // the source ULID (caller remaps to the new D id)
}

// ISO-8601 duration → seconds. GET returns totalTime/prepTime as "PT5M"/"PT2M" (write took
// seconds). Only H/M/S occur for recipe times; days/weeks never appear. Returns undefined for
// anything unparseable so a bad value maps to "no time" rather than corrupting the recreate.
function parseDuration(v: unknown): number | undefined {
  if (typeof v === "number") return v; // tolerate a future flat-seconds shape
  if (typeof v !== "string") return undefined;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v.trim());
  if (!m) return undefined;
  const [, h, mi, s] = m;
  const secs = (h ? +h * 3600 : 0) + (mi ? +mi * 60 : 0) + (s ? +s : 0);
  return secs > 0 ? secs : undefined;
}

export async function getCustomRecipeDetail(recipeId: string): Promise<CustomRecipeDetail> {
  const body = (await authedRead(
    "custom recipe detail fetch",
    `${BASE}/created-recipes/${PATH_LOCALE}/${encodeURIComponent(recipeId)}`,
  )) as Record<string, unknown>;
  // LIVE-VERIFIED shape (.international, 2026-06-21): EVERYTHING nests under recipeContent with
  // schema.org keys, NOT the flat write keys. Top level is only recipeId/authorId/timestamps/
  // status/workStatus. recipeIngredient & recipeInstructions come back as PLAIN STRINGS;
  // tools key is `tool`; yield is `recipeYield{value,unitText}`; times are ISO-8601 ("PT5M").
  // `hints` is ABSENT from GET — write-only, un-readable, therefore un-migratable (see
  // createCustomRecipeFull, which no longer replays hints).
  const rc = (body.recipeContent as Record<string, unknown> | undefined) ?? {};
  const name = (rc.name as string | undefined) ?? (body.name as string | undefined) ?? "";
  if (!name) {
    throw new Error(
      `custom recipe detail ${recipeId}: no name in response (shape changed?): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const y = rc.recipeYield as { value?: number; unitText?: string } | undefined;
  return {
    id: recipeId,
    name,
    ingredients: asTextList(rc.recipeIngredient),
    instructions: asTextList(rc.recipeInstructions),
    // hints not returned by GET — always undefined; left in the type for write-side symmetry.
    hints: undefined,
    tools: Array.isArray(rc.tool) ? (rc.tool as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
    totalTime: parseDuration(rc.totalTime),
    prepTime: parseDuration(rc.prepTime),
    yield: y && typeof y.value === "number" && typeof y.unitText === "string" ? { value: y.value, unitText: y.unitText } : undefined,
  };
}

// --- Phase C custom-recipe writes (create / patch / delete) -------------------
// LIVE-VERIFIED (.international, 2026-06-21, FULL/TRIAL account). Built to croeer/cookiput's
// PROVEN contract (cookie-only, plain json, NO Bearer, NO CSRF — confirmed from
// CookidooClient.py). Create/PATCH are SUBSCRIPTION-GATED: they 403 on a lapsed account (the
// gate, not auth or CSRF). Confirmed live: create + ingredients/instructions/tools/time/yield
// PATCH all succeed on a subscribed account. NOTE: the hints PATCH 400s on .international
// (body/hints must be null|string|anyOf) — its correct shape is locale-specific; see
// setCustomRecipeHints. In the real migrate, Target D is a subscribed account, so the gate
// never bites.
//
// Two-step create per cookiput: POST {recipeName} → {recipeId}, then PATCH attribute
// groups. PATCH is per-attribute (cookiput's production path): each call carries one group;
// the server accepts a single group, so a partial body is valid. We expose granular setters
// plus a convenience that drives them in sequence.

export interface CustomRecipeInput {
  name: string;
  ingredients?: string[]; // plain strings; wrapped into {type:"INGREDIENT",text}
  instructions?: string[]; // plain strings; wrapped into {type:"STEP",text}
  hints?: string[]; // plain strings (no wrapping — cookiput sends raw)
  tools?: string[]; // e.g. ["TM6"]
  totalTime?: number; // seconds
  prepTime?: number; // seconds
  yield?: { value: number; unitText: string };
}

// 8a step 1 — POST created-recipes/{lang} {recipeName} → {recipeId}. Plain json, no vendor Accept.
export async function createCustomRecipe(name: string): Promise<{ recipeId: string; raw: unknown }> {
  const body = (await authedWrite(
    "create custom recipe",
    "POST",
    `${BASE}/created-recipes/${PATH_LOCALE}`,
    { recipeName: name },
    `${BASE}/created-recipes/${PATH_LOCALE}`,
  )) as { recipeId?: string; id?: string };
  const recipeId = body.recipeId ?? body.id ?? "";
  if (!recipeId) throw new Error(`create custom recipe: no recipeId in response: ${JSON.stringify(body).slice(0, 200)}`);
  return { recipeId, raw: body };
}

// 8b — PATCH created-recipes/{lang}/{id} with ONE attribute group per call (PARTIAL body).
// This matches cookiput's proven production client (CookidooClient.py: rename_recipe L44
// {name}, add_ingredients L56 {ingredients}, add_steps L73 {instructions}, add_tools_and_time
// L84 {tools,totalTime,prepTime,yield}) — each a separate partial PATCH, never a full object.
// (Spec lines 122-124 suggest "default to full-object" off a discredited live 400; cookiput's
// working client overrides that. Re-confirm at active-account verify.) Low-level escape hatch;
// prefer the typed setters below. body is sent verbatim (partial bodies are valid).
export async function patchCustomRecipe(recipeId: string, body: Record<string, unknown>): Promise<unknown> {
  return authedWrite(
    "patch custom recipe",
    "PATCH",
    `${BASE}/created-recipes/${PATH_LOCALE}/${encodeURIComponent(recipeId)}`,
    body,
    `${BASE}/created-recipes/${PATH_LOCALE}`,
  );
}

export async function renameCustomRecipe(recipeId: string, name: string): Promise<unknown> {
  return patchCustomRecipe(recipeId, { name });
}

export async function setCustomRecipeIngredients(recipeId: string, ingredients: string[]): Promise<unknown> {
  return patchCustomRecipe(recipeId, {
    ingredients: ingredients.map((text) => ({ type: "INGREDIENT", text })),
  });
}

export async function setCustomRecipeInstructions(recipeId: string, instructions: string[]): Promise<unknown> {
  return patchCustomRecipe(recipeId, {
    instructions: instructions.map((text) => ({ type: "STEP", text })),
  });
}

// cookiput add_hints (L64) sends {hints: [...]} as plain strings (no {type,text} wrapping,
// unlike ingredients/instructions). Match the proven client. Verify shape at active-account.
export async function setCustomRecipeHints(recipeId: string, hints: string[]): Promise<unknown> {
  return patchCustomRecipe(recipeId, { hints });
}

export async function setCustomRecipeMeta(
  recipeId: string,
  meta: { tools?: string[]; totalTime?: number; prepTime?: number; yield?: { value: number; unitText: string } },
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (meta.tools) body.tools = meta.tools;
  if (typeof meta.totalTime === "number") body.totalTime = meta.totalTime;
  if (typeof meta.prepTime === "number") body.prepTime = meta.prepTime;
  if (meta.yield) body.yield = meta.yield;
  return patchCustomRecipe(recipeId, body);
}

// Thrown when a post-create PATCH fails AND the rollback DELETE also fails: the recipe is
// physically (partially) present in the account and could not be cleaned up. Carries the id so
// the caller (migrate) can record the orphan instead of losing it. A plain create+PATCH failure
// where rollback SUCCEEDS re-throws the original error — no orphan, no need for this type.
export class OrphanedRecipeError extends Error {
  constructor(public readonly recipeId: string, message: string) {
    super(message);
    this.name = "OrphanedRecipeError";
  }
}

// Convenience: full create. Drives create → PATCH groups in sequence (serial — each is a
// real write). Returns the new recipeId. This is what migrate uses to recreate a recipe in D.
//
// ROLLBACK: createCustomRecipe POSTs a fresh ULID (non-idempotent); if a later PATCH fails
// (e.g. entitlement 403 mid-sequence) we'd otherwise strand a named-but-empty recipe in the
// account. So we DELETE the partial recipe on any post-create failure and re-throw. Best-effort
// — if the cleanup DELETE also fails, throw OrphanedRecipeError carrying the id so the caller
// can surface the stranded recipe.
export async function createCustomRecipeFull(input: CustomRecipeInput): Promise<{ recipeId: string }> {
  const { recipeId } = await createCustomRecipe(input.name);
  try {
    if (input.ingredients?.length) await setCustomRecipeIngredients(recipeId, input.ingredients);
    if (input.instructions?.length) await setCustomRecipeInstructions(recipeId, input.instructions);
    // hints intentionally NOT replayed: GET never returns hints (live-verified .international
    // 2026-06-21), so migrate can never read them off a source recipe — input.hints is always
    // undefined here. Worse, the hints PATCH 400s on .international ("body/hints must be null,
    // string, or anyOf"), so replaying it would crash the sequence and roll back the whole
    // recipe. Un-readable + un-writable ⇒ drop. setCustomRecipeHints stays for callers that
    // know the correct per-locale shape.
    const hasMeta = input.tools?.length || input.totalTime || input.prepTime || input.yield;
    if (hasMeta) {
      await setCustomRecipeMeta(recipeId, {
        tools: input.tools,
        totalTime: input.totalTime,
        prepTime: input.prepTime,
        yield: input.yield,
      });
    }
  } catch (err) {
    try {
      await deleteCustomRecipe(recipeId);
    } catch (cleanupErr) {
      throw new OrphanedRecipeError(
        recipeId,
        `createCustomRecipeFull failed after create (${String(err)}) AND rollback delete of ` +
          `recipe ${recipeId} also failed (${String(cleanupErr)}) — an orphaned partial recipe remains.`,
      );
    }
    throw err;
  }
  return { recipeId };
}

// 8c — DELETE created-recipes/{lang}/{id} → 200/204 (miaucl; cookiput has no delete).
export async function deleteCustomRecipe(recipeId: string): Promise<unknown> {
  return authedWrite(
    "delete custom recipe",
    "DELETE",
    `${BASE}/created-recipes/${PATH_LOCALE}/${encodeURIComponent(recipeId)}`,
    { _method: "delete" },
    `${BASE}/created-recipes/${PATH_LOCALE}`,
  );
}

export interface Profile {
  id: string;
  username?: string;
  isPublic?: boolean;
  foodPreferences: string[];
  thermomixCount: number;
}

// GET /community/profile — NO locale segment (contrast organize/shopping/planning).
export async function getProfile(): Promise<Profile> {
  const body = (await authedRead("profile fetch", `${BASE}/community/profile`)) as {
    id?: string;
    isPublic?: boolean;
    foodPreferences?: string[];
    userInfo?: { username?: string };
    thermomixes?: unknown[];
  };
  return {
    id: body.id ?? "",
    username: body.userInfo?.username || undefined,
    isPublic: body.isPublic,
    foodPreferences: Array.isArray(body.foodPreferences) ? body.foodPreferences : [],
    thermomixCount: Array.isArray(body.thermomixes) ? body.thermomixes.length : 0,
  };
}

export interface SubscriptionDetail {
  active: boolean;
  subscriptionLevel?: string;
  type?: string;
  status?: string;
  startDate?: string;
  expires?: string;
  source?: string;
}

interface SubscriptionRaw {
  active?: boolean;
  subscriptionLevel?: string;
  type?: string;
  status?: string;
  startDate?: string;
  expires?: string;
  subscriptionSource?: string;
}

function pickCurrentSubscription(subs: SubscriptionRaw[]): SubscriptionRaw | undefined {
  if (subs.length === 0) return undefined;
  const activeOne = subs.find((s) => s.active);
  if (activeOne) return activeOne;
  // else newest by expiry (string ISO dates sort lexically) — don't assume [0] is current
  return [...subs].sort((a, b) => (b.expires ?? "").localeCompare(a.expires ?? ""))[0];
}

// GET /ownership/subscriptions — NO locale segment. Bare array; richer than the coarse
// search-token level (adds type/status/expiry/dates). Returns the current/most-recent one.
// Distinct from get_subscription (zero-cost coarse level); this is one authoritative request.
export async function getSubscriptionDetail(): Promise<SubscriptionDetail | null> {
  const body = await authedRead("subscription detail fetch", `${BASE}/ownership/subscriptions`);
  const subs = Array.isArray(body) ? (body as SubscriptionRaw[]) : [];
  const s = pickCurrentSubscription(subs);
  if (!s) return null;
  return {
    active: Boolean(s.active),
    subscriptionLevel: s.subscriptionLevel,
    type: s.type,
    status: s.status,
    startDate: s.startDate,
    expires: s.expires,
    source: s.subscriptionSource,
  };
}

export async function rateRecipe(recipeId: string, rating: number): Promise<unknown> {
  const normalizedId = normalizeRecipeId(recipeId);
  return authedWrite("rate recipe", "PUT", `${BASE}/rating/${PATH_LOCALE}/user-ratings/recipes/${encodeURIComponent(normalizedId)}`, {
    _method: "put",
    rating: String(rating),
  });
}

export { parseIsoDuration };
