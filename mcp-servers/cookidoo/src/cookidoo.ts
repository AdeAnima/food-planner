import { loadCookieHeader } from "./auth.ts";

const BASE = "https://cookidoo.de";
const ALGOLIA_APP_ID = "3TA8NT85XJ";
const ALGOLIA_HOST = "3ta8nt85xj-dsn.algolia.net";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_AUTH_RETRIES = 1;
const FETCH_TIMEOUT_MS = 15000;

let cachedToken: { apiKey: string; validUntil: number; subscriptionLevel: string } | null = null;

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
  headers.set("Accept-Language", "de-DE,de;q=0.9");
  const response = await fetchWithTimeout(url, { ...init, headers });
  return { response, cookie };
}

async function cookieChangedSince(prev: string | null): Promise<boolean> {
  if (!prev) return true;
  const current = await loadCookieHeader();
  return current !== prev;
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function persistentAuthError(operation: string, status: number): Error {
  return new Error(
    `${operation} failed with persistent auth failure after ${MAX_AUTH_RETRIES} retry: ${status}. ` +
      "Cookie file unchanged between retries — re-authenticate Cookidoo, then run " +
      "`bun run src/import-state.ts <path-to-playwright-state.json>` to refresh stored cookies.",
  );
}

function normalizeRecipeId(recipeId: string): string {
  return recipeId.startsWith("r") ? recipeId : `r${recipeId}`;
}

async function authedWrite(operation: string, method: string, url: string, body: unknown, referer = "https://cookidoo.de/"): Promise<unknown> {
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
      },
      body: JSON.stringify(body),
    });
    prevCookie = cookie;

    if (isAuthFailure(r.status)) {
      if (attempt >= MAX_AUTH_RETRIES) throw persistentAuthError(operation, r.status);
      continue;
    }

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

export async function getSearchToken(force = false): Promise<{ apiKey: string; subscriptionLevel: string }> {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cachedToken && cachedToken.validUntil > now + 60) {
    return { apiKey: cachedToken.apiKey, subscriptionLevel: cachedToken.subscriptionLevel };
  }
  const { response: r } = await authedFetch(`${BASE}/search/api/subscription/token`);
  if (!r.ok) throw new Error(`cookidoo token endpoint failed: ${r.status} ${await r.text()}`);
  const json = (await r.json()) as SubscriptionTokenResponse;
  cachedToken = { apiKey: json.apiKey, validUntil: json.validUntil, subscriptionLevel: json.subscriptionLevel };
  return { apiKey: json.apiKey, subscriptionLevel: json.subscriptionLevel };
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
        indexName: "recipes-production-de",
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
  const url = `${BASE}/recipes/recipe/de-DE/${recipeId}`;
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
  const { response: r, cookie } = await authedFetch(`${BASE}/planning/de-DE/api/my-day/${encodeURIComponent(dayKey)}`);
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
    recipeCount: typeof data.recipeCount === "number" ? data.recipeCount : undefined,
  };
}

export async function getWeekPlan(startDate?: string, span = 7, attempt = 0, prevCookie: string | null = null): Promise<WeekPlan> {
  const date = startDate ?? getCurrentWeekMonday();
  if (attempt > 0 && !(await cookieChangedSince(prevCookie))) {
    throw persistentAuthError("week plan fetch", 401);
  }
  const { response: r, cookie } = await authedFetch(`${BASE}/planning/de-DE/api/my-day/planned-recipes/${date}?span=${span}`);
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
  options: { force?: boolean } = {},
): Promise<{ added: string[]; skipped: string[] }> {
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

      toAdd = [];
      for (const id of normalizedIds) {
        if (existing.has(id)) skipped.push(id);
        else toAdd.push(id);
      }
    } catch (e) {
      throw new Error(
        `add to week: could not read day plan ${dayKey} for dedupe check: ${e instanceof Error ? e.message : String(e)}. ` +
          "Pass force:true to skip the dedupe read and add unconditionally.",
      );
    }
  }

  if (toAdd.length === 0) {
    return { added: [], skipped };
  }

  await authedWrite("add to week", "PUT", `${BASE}/planning/de-DE/api/my-day`, {
    _method: "put",
    recipeSource: "VORWERK",
    recipeIds: toAdd,
    dayKey,
  });
  return { added: toAdd, skipped };
}

export async function removeFromWeek(recipeId: string, dayKey: string): Promise<unknown> {
  const normalizedId = normalizeRecipeId(recipeId);
  const encodedDayKey = encodeURIComponent(dayKey);
  const encodedRecipeId = encodeURIComponent(normalizedId);
  return authedWrite(
    "remove from week",
    "DELETE",
    `${BASE}/planning/de-DE/api/my-day/${encodedDayKey}/recipes/${encodedRecipeId}?recipeSource=VORWERK`,
    {
      _method: "delete",
      dayKey,
      recipeId: normalizedId,
      recipeSource: "VORWERK",
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
    for (const recipe of day.recipes) {
      const recipeId = recipe.id ?? (typeof recipe.recipeId === "string" ? recipe.recipeId : undefined);
      if (!recipeId) continue;

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
  return authedWrite("add to shopping list", "POST", `${BASE}/shopping/de-DE/add-recipes`, {
    recipeIDs: recipeIds.map(normalizeRecipeId),
  });
}

export async function markOwned(ingredientIds: string[]): Promise<unknown> {
  return authedWrite("mark owned", "POST", `${BASE}/shopping/de-DE/owned-ingredients`, {
    ingredientIDS: ingredientIds,
  });
}

export async function unmarkOwned(ingredientId: string): Promise<unknown> {
  return authedWrite("unmark owned", "DELETE", `${BASE}/shopping/de/owned-ingredients/${encodeURIComponent(ingredientId)}`, {
    _method: "delete",
  });
}

export async function bookmarkRecipe(recipeId: string): Promise<unknown> {
  return authedWrite("bookmark recipe", "PUT", `${BASE}/organize/de-DE/api/bookmark`, {
    recipeId: normalizeRecipeId(recipeId),
  });
}

export async function unbookmarkRecipe(recipeId: string): Promise<unknown> {
  return authedWrite("unbookmark recipe", "DELETE", `${BASE}/organize/de-DE/api/bookmark`, {
    recipeId: normalizeRecipeId(recipeId),
  });
}

export async function rateRecipe(recipeId: string, rating: number): Promise<unknown> {
  const normalizedId = normalizeRecipeId(recipeId);
  return authedWrite("rate recipe", "PUT", `${BASE}/rating/de-DE/user-ratings/recipes/${encodeURIComponent(normalizedId)}`, {
    _method: "put",
    rating: String(rating),
  });
}

export { parseIsoDuration };
