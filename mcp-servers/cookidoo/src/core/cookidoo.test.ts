import { test, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";

// Mock must provide every symbol cookidoo.ts imports from auth.ts, else the module fails to load
// with "Export named '…' not found". cookidoo.ts imports: loadCookieHeader, setCookieOverride,
// getCachedToken, setCachedToken. Tests override globalThis.fetch, so these are inert stubs.
mock.module("./auth.ts", () => ({
  loadCookieHeader: async () => "stub=1",
  setCookieOverride: () => {},
  getCachedToken: () => null,
  setCachedToken: () => {},
}));

let addToWeek: typeof import("./cookidoo.ts").addToWeek;
let getWeekPlan: typeof import("./cookidoo.ts").getWeekPlan;
let getDayPlan: typeof import("./cookidoo.ts").getDayPlan;
let removeFromWeek: typeof import("./cookidoo.ts").removeFromWeek;
let clearWeek: typeof import("./cookidoo.ts").clearWeek;
let getShoppingList: typeof import("./cookidoo.ts").getShoppingList;
let getBookmarks: typeof import("./cookidoo.ts").getBookmarks;
let getCollections: typeof import("./cookidoo.ts").getCollections;
let getCustomRecipes: typeof import("./cookidoo.ts").getCustomRecipes;
let getProfile: typeof import("./cookidoo.ts").getProfile;
let getSubscriptionDetail: typeof import("./cookidoo.ts").getSubscriptionDetail;
let addRecipesToCollection: typeof import("./cookidoo.ts").addRecipesToCollection;
let renameCollection: typeof import("./cookidoo.ts").renameCollection;
let getCollection: typeof import("./cookidoo.ts").getCollection;
let addRecipeIngredients: typeof import("./cookidoo.ts").addRecipeIngredients;
let createCustomRecipeFull: typeof import("./cookidoo.ts").createCustomRecipeFull;
let editAdditionalItemOwnership: typeof import("./cookidoo.ts").editAdditionalItemOwnership;
let editOwnedIngredients: typeof import("./cookidoo.ts").editOwnedIngredients;
let getCustomRecipeDetail: typeof import("./cookidoo.ts").getCustomRecipeDetail;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  ({
    addToWeek,
    getWeekPlan,
    getDayPlan,
    removeFromWeek,
    clearWeek,
    getShoppingList,
    getBookmarks,
    getCollections,
    getCustomRecipes,
    getProfile,
    getSubscriptionDetail,
    addRecipesToCollection,
    renameCollection,
    getCollection,
    addRecipeIngredients,
    createCustomRecipeFull,
    editAdditionalItemOwnership,
    editOwnedIngredients,
    getCustomRecipeDetail,
  } = await import("./cookidoo.ts"));
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let calls: Call[];

/** Install a fetch router. `handler` maps a request to a Response (or throws). */
function routeFetch(handler: (c: Call) => Response): void {
  globalThis.fetch = (async (url: any, init: any) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method, url: u, body };
    calls.push(call);
    return handler(call);
  }) as any;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
});

// --- addToWeek dedup ---------------------------------------------------------

test("addToWeek: skips a recipe already present via day.recipes[].id", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r123", title: "X" }] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["r123"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r123"]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: skips a recipe present via day.recipeIds", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [], recipeIds: ["r999"] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["r999"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r999"]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: normalizes bare id vs r-prefixed existing id for dedupe", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r123" }] });
    }
    return new Response(null, { status: 204 });
  });
  // input is bare "123", existing is "r123" → must match and skip
  const res = await addToWeek(["123"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r123"]);
});

test("addToWeek: normalizes r-prefixed input vs bare existing id for dedupe", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "123" }] });
    }
    return new Response(null, { status: 204 });
  });
  // existing is bare "123", input is "r123" → must normalize both sides and skip
  const res = await addToWeek(["r123"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r123"]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: dedupes against the day.recipes[].recipeId representation", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ recipeId: "r123" }] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["r123"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r123"]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: adds only the not-yet-present recipes, writes normalized ids", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r111" }] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["111", "222"], "2026-05-25");
  expect(res.added).toEqual(["r222"]);
  expect(res.skipped).toEqual(["r111"]);
  const put = calls.find((c) => c.method === "PUT");
  expect(put).toBeDefined();
  expect((put!.body as any).recipeIds).toEqual(["r222"]);
});

test("addToWeek: force:true skips the dedupe read and writes all inputs", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  const res = await addToWeek(["123", "456"], "2026-05-25", { force: true });
  expect(res.added).toEqual(["r123", "r456"]);
  expect(res.skipped).toEqual([]);
  // no GET dedupe read performed
  expect(calls.some((c) => c.method === "GET")).toBe(false);
  expect(calls.some((c) => c.method === "PUT")).toBe(true);
});

test("addToWeek: dedupes duplicate inputs before write", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  const res = await addToWeek(["123", "r123", "123"], "2026-05-25", { force: true });
  expect(res.added).toEqual(["r123"]);
  const put = calls.find((c) => c.method === "PUT");
  expect((put!.body as any).recipeIds).toEqual(["r123"]);
});

test("addToWeek: all-present → no write, returns added:[] skipped:[...]", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r1" }, { id: "r2" }] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["r1", "r2"], "2026-05-25");
  expect(res.added).toEqual([]);
  expect(res.skipped).toEqual(["r1", "r2"]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: day-plan read failure throws with actionable message (no silent add)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return new Response("boom", { status: 500 });
    }
    return new Response(null, { status: 204 });
  });
  await expect(addToWeek(["r1"], "2026-05-25")).rejects.toThrow(/could not read day plan/);
  // critical: must NOT have fallen through to the write
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("addToWeek: day-plan 404 (empty day) → adds all, no throw", async () => {
  // my-day returns 404 for a day with zero recipes (E004 "Day is not found"), distinct from
  // 500/auth. Empty day = nothing to dedupe against → add all. Must NOT throw like the 500 path.
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return new Response("Day is not found", { status: 404 });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek(["r1", "r2"], "2026-05-25");
  expect(res.added).toEqual(["r1", "r2"]);
  expect(res.skipped).toEqual([]);
  expect(calls.some((c) => c.method === "PUT")).toBe(true);
});

// --- custom (CUSTOMER-source) week recipes -----------------------------------
// Customs come back in a SEPARATE top-level `customerRecipeIds` array (bare ULIDs), never in
// recipes/recipeIds. These tests pin the read/dedupe/remove/clear handling for that array.

const ULID = "01KVP2FY12SGNHPJAHRGXP6JX5"; // 26-char → isCustomRecipeId() true

test("getDayPlan: parses top-level customerRecipeIds", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [], recipeIds: [], customerRecipeIds: [ULID], recipeCount: 1 });
    }
    return new Response(null, { status: 204 });
  });
  const day = await getDayPlan("2026-05-25");
  expect(day.customerRecipeIds).toEqual([ULID]);
  expect(day.recipeCount).toBe(1);
});

test("getDayPlan: customerRecipeIds absent → undefined (not crash)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [] });
    }
    return new Response(null, { status: 204 });
  });
  const day = await getDayPlan("2026-05-25");
  expect(day.customerRecipeIds).toBeUndefined();
});

test("addToWeek: dedupes against customerRecipeIds (a custom already on the day is skipped)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [], customerRecipeIds: [ULID] });
    }
    return new Response(null, { status: 204 });
  });
  const res = await addToWeek([ULID], "2026-05-25", { recipeSource: "CUSTOMER" });
  expect(res.skipped).toEqual([ULID]);
  expect(res.added).toEqual([]);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
});

test("removeFromWeek: a custom (ULID) id auto-selects recipeSource=CUSTOMER", async () => {
  routeFetch(() => new Response(null, { status: 200 }));
  await removeFromWeek(ULID, "2026-05-25");
  const del = calls.find((c) => c.method === "DELETE");
  expect(del).toBeDefined();
  expect(del!.url).toContain("recipeSource=CUSTOMER");
  expect((del!.body as any).recipeSource).toBe("CUSTOMER");
});

test("removeFromWeek: a catalog (r-numeric) id auto-selects recipeSource=VORWERK", async () => {
  routeFetch(() => new Response(null, { status: 200 }));
  await removeFromWeek("r123", "2026-05-25");
  const del = calls.find((c) => c.method === "DELETE");
  expect(del!.url).toContain("recipeSource=VORWERK");
  expect((del!.body as any).recipeSource).toBe("VORWERK");
});

test("clearWeek: removes both catalog recipes and customerRecipeIds", async () => {
  routeFetch((c) => {
    if (c.url.includes("/planned-recipes/")) return json({ dayKeys: ["2026-05-25"] });
    if (c.method === "GET" && c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r123" }], customerRecipeIds: [ULID] });
    }
    return new Response(null, { status: 200 }); // DELETEs
  });
  const res = await clearWeek("2026-05-25", 1);
  expect(res.removed).toBe(2);
  const dels = calls.filter((c) => c.method === "DELETE");
  expect(dels.length).toBe(2);
  // catalog → VORWERK, custom → CUSTOMER (auto-detected per id)
  expect(dels.some((d) => d.url.includes("r123") && d.url.includes("recipeSource=VORWERK"))).toBe(true);
  expect(dels.some((d) => d.url.includes(ULID) && d.url.includes("recipeSource=CUSTOMER"))).toBe(true);
});

// --- getWeekPlan partial-failure ---------------------------------------------

test("getWeekPlan: rejects rather than returning a partial plan when a day fails", async () => {
  routeFetch((c) => {
    if (c.url.includes("/planned-recipes/")) {
      return json({ dayKeys: ["2026-05-25", "2026-05-26"] });
    }
    if (c.url.includes("/my-day/2026-05-25")) {
      return json({ recipes: [{ id: "r1" }] });
    }
    if (c.url.includes("/my-day/2026-05-26")) {
      return new Response("nope", { status: 500 });
    }
    return new Response(null, { status: 204 });
  });
  await expect(getWeekPlan("2026-05-25")).rejects.toThrow(/refusing to return a partial plan/);
});

test("getWeekPlan: rejects on an auth-failed day (after retry exhausted), not partial", async () => {
  routeFetch((c) => {
    if (c.url.includes("/planned-recipes/")) {
      return json({ dayKeys: ["2026-05-25", "2026-05-26"] });
    }
    if (c.url.includes("/my-day/2026-05-25")) return json({ recipes: [{ id: "r1" }] });
    // day 26 always 401 → getDayPlan retries once, cookie unchanged → persistentAuthError
    if (c.url.includes("/my-day/2026-05-26")) return new Response("no", { status: 401 });
    return new Response(null, { status: 204 });
  });
  await expect(getWeekPlan("2026-05-25")).rejects.toThrow(/refusing to return a partial plan/);
});

test("getWeekPlan: returns all days when every day loads", async () => {
  routeFetch((c) => {
    if (c.url.includes("/planned-recipes/")) {
      return json({ dayKeys: ["2026-05-25", "2026-05-26"] });
    }
    if (c.url.includes("/my-day/2026-05-25")) return json({ recipes: [{ id: "r1" }] });
    if (c.url.includes("/my-day/2026-05-26")) return json({ recipes: [{ id: "r2" }] });
    return new Response(null, { status: 204 });
  });
  const plan = await getWeekPlan("2026-05-25");
  expect(plan.dayKeys.map((d) => d.date)).toEqual(["2026-05-25", "2026-05-26"]);
});

// --- getShoppingList parse ---------------------------------------------------
// Shape mirrors a real GET /shopping/de-DE response captured live 2026-06-21.

test("getShoppingList: flattens ingredient groups, parses owned/qty/unit, tags source recipe", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/shopping/")) {
      return json({
        recipes: [
          {
            id: "r249341",
            title: "Linsen-Spinat-Curry",
            recipeIngredientGroups: [
              { id: "ing1", isOwned: false, optional: false, ingredientNotation: "Möhren", unitNotation: "g", quantity: { value: 400 }, shoppingCategory_ref: "cat-1" },
              { id: "ing2", isOwned: true, optional: true, ingredientNotation: "Salz", quantity: {} },
            ],
          },
        ],
        customerRecipes: [
          { id: "rc1", title: "My Recipe", recipeIngredientGroups: [{ id: "ing3", isOwned: false, ingredientNotation: "Reis" }] },
        ],
        additionalItems: [{ id: "a1", name: "Servietten", isOwned: false }],
      });
    }
    return new Response(null, { status: 204 });
  });
  const list = await getShoppingList();
  expect(list.recipeCount).toBe(2); // recipes + customerRecipes merged
  expect(list.ingredients).toHaveLength(3);
  expect(list.ingredients[0]).toEqual({
    id: "ing1", isOwned: false, name: "Möhren", quantity: 400, unit: "g", optional: false, category: "cat-1", recipeId: "r249341", recipeTitle: "Linsen-Spinat-Curry",
  });
  expect(list.ingredients[1]!.isOwned).toBe(true);
  expect(list.ingredients[1]!.quantity).toBeUndefined(); // empty quantity object → undefined value
  expect(list.ingredients[2]!.recipeId).toBe("rc1"); // customer recipe ingredient tagged to its recipe
  expect(list.additionalItems).toHaveLength(1);
});

test("getShoppingList: tolerates empty/missing arrays and drops groups without an id", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/shopping/")) {
      return json({ recipes: [{ id: "r1", recipeIngredientGroups: [{ isOwned: false, ingredientNotation: "no-id" }, { id: "ok" }] }] });
    }
    return new Response(null, { status: 204 });
  });
  const list = await getShoppingList();
  expect(list.recipeCount).toBe(1);
  expect(list.ingredients).toHaveLength(1); // group without id dropped
  expect(list.ingredients[0]!.id).toBe("ok");
  expect(list.additionalItems).toEqual([]);
});

// --- Phase B reads -----------------------------------------------------------
// Shapes mirror real responses captured live 2026-06-21.

test("getBookmarks: maps recipe id/title/image, drops bookmarks without a recipe id", async () => {
  routeFetch((c) => {
    if (c.url.includes("/api/bookmark")) {
      return json({
        bookmarks: [
          { id: "FAV-1", recipe: { id: "r361720", asciiTitle: "Pesto", landscapeImage: "img1", prepTime: "900.0", locale: "de-DE" } },
          { id: "FAV-2", recipe: {} }, // no recipe id → dropped
        ],
        listType: "BOOKMARKLIST",
        page: { page: 0, totalPages: 1, totalElements: 2 },
      });
    }
    return new Response(null, { status: 204 });
  });
  const bms = await getBookmarks();
  expect(bms).toHaveLength(1);
  expect(bms[0]).toEqual({ id: "FAV-1", recipeId: "r361720", title: "Pesto", image: "img1", prepTime: "900.0", locale: "de-DE" });
});

test("getBookmarks: walks all pages (page-0-only would silently cap a heavy account)", async () => {
  routeFetch((c) => {
    const m = c.url.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 0;
    return json({
      bookmarks: [{ id: `FAV-${page}`, recipe: { id: `r${page}`, asciiTitle: `t${page}` } }],
      page: { page, totalPages: 3, totalElements: 3 },
    });
  });
  const bms = await getBookmarks();
  expect(bms.map((b) => b.recipeId)).toEqual(["r0", "r1", "r2"]); // 3 pages fetched + concatenated
  const pages = calls.map((c) => (c.url.match(/[?&]page=(\d+)/) ?? [])[1]);
  expect(pages).toEqual(["0", "1", "2"]); // stopped at totalPages, no over-fetch
});

test("getCollections: merges custom + managed lists, tags listType, counts chapter recipes", async () => {
  routeFetch((c) => {
    if (c.url.includes("/custom-list")) {
      return json({
        customlists: [{ id: "01JR6", title: "Favorites", listType: "CUSTOMLIST", shared: false, chapters: [{ recipes: [1, 2] }, { recipes: [3] }] }],
        page: { page: 0, totalPages: 1 },
      });
    }
    if (c.url.includes("/managed-list")) {
      return json({
        managedlists: [{ id: "ML1", title: "Vegan!", author: "Vorwerk", chapters: [{ recipes: [1] }] }],
        page: { page: 0, totalPages: 1 },
      });
    }
    return new Response(null, { status: 204 });
  });
  const cols = await getCollections();
  expect(cols).toHaveLength(2);
  expect(cols[0]).toEqual({ id: "01JR6", title: "Favorites", listType: "CUSTOMLIST", author: undefined, shared: false, recipeCount: 3 });
  expect(cols[1]).toEqual({ id: "ML1", title: "Vegan!", listType: "MANAGEDLIST", author: "Vorwerk", shared: undefined, recipeCount: 1 });
});

test("getCollections: empty/absent chapters → recipeCount 0 (live: an empty list inlines a chapter with recipes:[])", async () => {
  routeFetch((c) => {
    if (c.url.includes("/custom-list")) {
      // Mirrors a real empty custom list: chapters present, recipes inlined but empty.
      return json({ customlists: [{ id: "EMPTY", title: "New List", listType: "CUSTOMLIST", chapters: [{ title: "x", recipes: [] }] }], page: { page: 0, totalPages: 1 } });
    }
    if (c.url.includes("/managed-list")) {
      // chapters key absent entirely — must not throw, count 0.
      return json({ managedlists: [{ id: "NOCH", title: "Bare", author: "Vorwerk" }], page: { page: 0, totalPages: 1 } });
    }
    return new Response(null, { status: 204 });
  });
  const cols = await getCollections();
  expect(cols[0].recipeCount).toBe(0);
  expect(cols[1].recipeCount).toBe(0);
});

test("getCollections: sends the vendor Accept media types for each list endpoint", async () => {
  const accepts: Record<string, string> = {};
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    accepts[u.includes("custom-list") ? "custom" : u.includes("managed-list") ? "managed" : "other"] = new Headers(init?.headers).get("Accept") ?? "";
    const key = u.includes("custom-list") ? "customlists" : "managedlists";
    return json({ [key]: [], page: { totalPages: 1 } });
  }) as any;
  await getCollections();
  expect(accepts.custom).toBe("application/vnd.vorwerk.organize.custom-list.mobile+json");
  expect(accepts.managed).toBe("application/vnd.vorwerk.organize.managed-list.mobile+json");
});

test("getCustomRecipes: maps recipeContent.name/image and status fields, single unpaginated request", async () => {
  const urls: string[] = [];
  routeFetch((c) => {
    urls.push(c.url);
    if (c.url.includes("/created-recipes/")) {
      // Real endpoint shape: {items,meta}, NO `page` block, `?page=` ignored.
      return json({
        items: [
          { recipeId: "01JHR24C", status: "ACTIVE", workStatus: "PRIVATE", modifiedAt: "2026-01-01", createdAt: "2025-12-01", recipeContent: { name: "Test", image: "img" } },
        ],
        meta: { recipeLimit: 0 },
      });
    }
    return new Response(null, { status: 204 });
  });
  const recs = await getCustomRecipes();
  expect(recs).toHaveLength(1);
  expect(recs[0]).toEqual({ id: "01JHR24C", name: "Test", status: "ACTIVE", workStatus: "PRIVATE", modifiedAt: "2026-01-01", createdAt: "2025-12-01", image: "img" });
  // Not paginated: exactly one created-recipes request, no `?page=` param.
  const crCalls = urls.filter((u) => u.includes("/created-recipes/"));
  expect(crCalls).toHaveLength(1);
  expect(crCalls[0]).not.toContain("page=");
});

test("getProfile: extracts username, food prefs, thermomix count from nested shape", async () => {
  routeFetch((c) => {
    if (c.url.includes("/community/profile")) {
      return json({ id: "1abf30ff", isPublic: false, foodPreferences: ["vegetarian"], userInfo: { username: "chef" }, thermomixes: [{ id: "tm6" }] });
    }
    return new Response(null, { status: 204 });
  });
  const p = await getProfile();
  expect(p).toEqual({ id: "1abf30ff", username: "chef", isPublic: false, foodPreferences: ["vegetarian"], thermomixCount: 1 });
});

test("getProfile: empty username string becomes undefined, missing arrays default", async () => {
  routeFetch((c) => {
    if (c.url.includes("/community/profile")) return json({ id: "x", userInfo: { username: "" } });
    return new Response(null, { status: 204 });
  });
  const p = await getProfile();
  expect(p.username).toBeUndefined();
  expect(p.foodPreferences).toEqual([]);
  expect(p.thermomixCount).toBe(0);
});

test("getSubscriptionDetail: picks the active subscription over an ended one", async () => {
  routeFetch((c) => {
    if (c.url.includes("/ownership/subscriptions")) {
      return json([
        { active: false, status: "ENDED", expires: "2025-01-31T23:59:00Z", subscriptionLevel: "NONE", type: "TRIAL", subscriptionSource: "COMMERCE" },
        { active: true, status: "ACTIVE", expires: "2027-01-01T00:00:00Z", subscriptionLevel: "FULL", type: "PAID", startDate: "2026-01-01T00:00:00Z" },
      ]);
    }
    return new Response(null, { status: 204 });
  });
  const s = await getSubscriptionDetail();
  expect(s?.active).toBe(true);
  expect(s?.subscriptionLevel).toBe("FULL");
});

test("getSubscriptionDetail: no active → newest by expiry, not array[0]", async () => {
  routeFetch((c) => {
    if (c.url.includes("/ownership/subscriptions")) {
      return json([
        { active: false, expires: "2024-01-01T00:00:00Z", subscriptionLevel: "OLD" },
        { active: false, expires: "2025-06-01T00:00:00Z", subscriptionLevel: "NEWER" },
      ]);
    }
    return new Response(null, { status: 204 });
  });
  const s = await getSubscriptionDetail();
  expect(s?.subscriptionLevel).toBe("NEWER");
});

test("getSubscriptionDetail: empty array → null", async () => {
  routeFetch((c) => {
    if (c.url.includes("/ownership/subscriptions")) return json([]);
    return new Response(null, { status: 204 });
  });
  expect(await getSubscriptionDetail()).toBeNull();
});

// --- Phase C: addRecipesToCollection GET-merge-PUT (clobber prevention) -------
// The PUT replaces the whole membership, so a bug here silently DELETES a user's
// collection. These guard the union: existing recipes must always survive.

function collectionGet(recipeIds: string[]): Response {
  return json({ id: "L1", title: "T", chapters: [{ recipes: recipeIds.map((id) => ({ id })) }] });
}

test("addRecipesToCollection: PUTs the UNION of existing + new (never clobbers)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1")) return collectionGet(["r100", "r200"]);
    return new Response(null, { status: 204 });
  });
  const res = await addRecipesToCollection("L1", ["r300"]);
  const put = calls.find((c) => c.method === "PUT");
  expect(put).toBeTruthy();
  const sent = (put!.body as { recipeIds: string[] }).recipeIds;
  // existing two preserved + new one — order-independent
  expect(new Set(sent)).toEqual(new Set(["r100", "r200", "r300"]));
  expect(res.added).toEqual(["r300"]);
  expect(new Set(res.alreadyPresent)).toEqual(new Set());
});

test("addRecipesToCollection: all-present → no PUT at all (no needless write)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1")) return collectionGet(["r100"]);
    return new Response(null, { status: 204 });
  });
  const res = await addRecipesToCollection("L1", ["100"]); // un-prefixed input normalizes to r100
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  expect(res.added).toEqual([]);
  expect(res.alreadyPresent).toEqual(["r100"]);
});

test("addRecipesToCollection: dedupes and normalizes; lowercase recipeIds key (collection casing trap)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1")) return collectionGet([]);
    return new Response(null, { status: 204 });
  });
  await addRecipesToCollection("L1", ["r5", "5", "r6"]); // r5 and 5 are the same recipe
  const put = calls.find((c) => c.method === "PUT")!;
  const body = put.body as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["recipeIds"]); // lowercase, not recipeIDs
  expect(new Set(body.recipeIds as string[])).toEqual(new Set(["r5", "r6"]));
});

// --- Phase B: renameCollection GET-merge-PUT (title + membership preserved) ----
// Same blind-PUT endpoint as addRecipesToCollection: a {title}-only PUT would WIPE
// recipeIds. Prove the PUT carries BOTH the new title AND the current membership.

test("renameCollection: PUTs new title AND preserves existing membership (no wipe)", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1")) return collectionGet(["r100", "r200"]);
    return new Response(null, { status: 204 });
  });
  const res = await renameCollection("L1", "Renamed");
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put).toBeTruthy();
  const body = put.body as { title: string; recipeIds: string[] };
  expect(body.title).toBe("Renamed");
  // existing members survive the title change — order-independent
  expect(new Set(body.recipeIds)).toEqual(new Set(["r100", "r200"]));
  expect(res.title).toBe("Renamed");
  expect(res.total).toBe(2);
});

test("renameCollection: empty collection renames without inventing members", async () => {
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1")) return collectionGet([]);
    return new Response(null, { status: 204 });
  });
  await renameCollection("L1", "Empty");
  const put = calls.find((c) => c.method === "PUT")!;
  const body = put.body as { title: string; recipeIds: string[] };
  expect(body.title).toBe("Empty");
  expect(body.recipeIds).toEqual([]);
});

// --- Phase C: casing-trap guards (shopping uses CAPITAL recipeIDs) ------------

test("addRecipeIngredients: VORWERK sends CAPITAL recipeIDs as bare ids", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  await addRecipeIngredients(["123"]);
  const post = calls.find((c) => c.url.includes("/recipes/add"))!;
  const body = post.body as Record<string, unknown>;
  expect(body.recipeIDs).toEqual(["r123"]); // capital IDs, normalized
});

test("addRecipeIngredients: CUSTOMER sends {id,source} objects with RAW ULID (no r-prefix)", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  // CUSTOMER ids are ULIDs (letters) — must NOT be r-prefixed (that corrupts the id).
  await addRecipeIngredients(["01HXYZABCDEFG"], "CUSTOMER");
  const post = calls.find((c) => c.url.includes("/recipes/add"))!;
  const body = post.body as { recipeIDs: Array<{ id: string; source: string }> };
  expect(body.recipeIDs).toEqual([{ id: "01HXYZABCDEFG", source: "CUSTOMER" }]);
});

test("editAdditionalItemOwnership: defaults ownedTimestamp when marking owned", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  await editAdditionalItemOwnership([{ id: "a1", isOwned: true }]);
  const post = calls.find((c) => c.url.includes("/additional-items/ownership/edit"))!;
  const item = (post.body as { additionalItems: Array<{ ownedTimestamp: number }> }).additionalItems[0]!;
  expect(typeof item.ownedTimestamp).toBe("number");
  expect(item.ownedTimestamp).toBeGreaterThan(0);
});

test("editOwnedIngredients (7g): uses `ingredients` key + owned-ingredients endpoint (casing trap)", async () => {
  routeFetch(() => new Response(null, { status: 204 }));
  await editOwnedIngredients([{ id: "i1", isOwned: true }]);
  const post = calls.find((c) => c.url.includes("/owned-ingredients/ownership/edit"))!;
  expect(post).toBeTruthy();
  const body = post.body as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["ingredients"]); // NOT additionalItems
  const item = (body.ingredients as Array<{ ownedTimestamp: number }>)[0]!;
  expect(item.ownedTimestamp).toBeGreaterThan(0);
});

// --- Phase C: custom recipe full create drives create→PATCH in order ----------

test("createCustomRecipeFull: POST create then PATCH groups, wrapping strings into typed objects", async () => {
  routeFetch((c) => {
    if (c.method === "POST" && c.url.endsWith("/created-recipes/de-DE")) return json({ recipeId: "REC1" });
    return new Response(null, { status: 204 });
  });
  const res = await createCustomRecipeFull({
    name: "Test",
    ingredients: ["100 g Mehl"],
    instructions: ["Mischen"],
    tools: ["TM6"],
    totalTime: 600,
  });
  expect(res.recipeId).toBe("REC1");
  const create = calls.find((c) => c.method === "POST")!;
  expect(create.body).toEqual({ recipeName: "Test" });
  const patches = calls.filter((c) => c.method === "PATCH");
  expect(patches.length).toBe(3); // ingredients, instructions, meta
  const ingPatch = patches.find((p) => (p.body as any).ingredients)!;
  expect((ingPatch.body as any).ingredients).toEqual([{ type: "INGREDIENT", text: "100 g Mehl" }]);
  const insPatch = patches.find((p) => (p.body as any).instructions)!;
  expect((insPatch.body as any).instructions).toEqual([{ type: "STEP", text: "Mischen" }]);
  const metaPatch = patches.find((p) => (p.body as any).tools)!;
  expect((metaPatch.body as any).tools).toEqual(["TM6"]);
  expect((metaPatch.body as any).totalTime).toBe(600);
});

// --- Phase C: getCollection FAIL-LOUD guards (silent-wipe defense) -------------
// addRecipesToCollection blind-PUTs (existing ∪ new). If getCollection misparses and
// returns [], the PUT wipes the collection. These prove the guards throw instead.

test("getCollection: THROWS when body has no `chapters` array (wrong shape, not empty)", async () => {
  // A genuinely empty collection returns `chapters: [...]`; an ABSENT chapters means our
  // assumed shape is wrong — must throw, never silently return [] (which would wipe on PUT).
  routeFetch(() => json({ id: "L1", title: "T", recipes: [{ id: "r100" }] })); // recipes top-level, no chapters
  await expect(getCollection("L1")).rejects.toThrow(/no `chapters` array/);
});

test("getCollection: empty collection (chapters present, no recipes) → [] WITHOUT throwing", async () => {
  routeFetch(() => json({ id: "L1", title: "T", chapters: [{ recipes: [] }] }));
  const res = await getCollection("L1");
  expect(res.recipeIds).toEqual([]);
});

test("getCollection: THROWS on a paginated body (would drop the un-fetched tail)", async () => {
  routeFetch(() => json({ id: "L1", chapters: [{ recipes: [{ id: "r1" }] }], page: { totalPages: 3 } }));
  await expect(getCollection("L1")).rejects.toThrow(/paginated/);
});

test("addRecipesToCollection: a ULID member already present SURVIVES the union (no r-prefix corruption)", async () => {
  // Server stores a custom (ULID) recipe in the collection. Adding a numeric recipe must NOT
  // rewrite the ULID to r<ulid> — it must be PUT back byte-identical.
  routeFetch((c) => {
    if (c.method === "GET" && c.url.includes("/custom-list/L1"))
      return json({ id: "L1", chapters: [{ recipes: [{ id: "01HULIDMEMBER" }] }] });
    return new Response(null, { status: 204 });
  });
  await addRecipesToCollection("L1", ["123"]);
  const put = calls.find((c) => c.method === "PUT")!;
  const sent = (put.body as { recipeIds: string[] }).recipeIds;
  expect(new Set(sent)).toEqual(new Set(["01HULIDMEMBER", "r123"])); // ULID raw, numeric prefixed
});

// --- Phase C: createCustomRecipeFull rollback on mid-sequence PATCH failure ----

test("createCustomRecipeFull: DELETEs the partial recipe when a later PATCH fails", async () => {
  routeFetch((c) => {
    if (c.method === "POST" && c.url.endsWith("/created-recipes/de-DE")) return json({ recipeId: "REC1" });
    if (c.method === "PATCH") return new Response("forbidden", { status: 403 }); // entitlement gate mid-sequence
    return new Response(null, { status: 204 }); // the rollback DELETE succeeds
  });
  await expect(
    createCustomRecipeFull({ name: "Test", ingredients: ["100 g Mehl"] }),
  ).rejects.toThrow();
  const del = calls.find((c) => c.method === "DELETE" && c.url.includes("/created-recipes/de-DE/REC1"));
  expect(del).toBeTruthy(); // orphan cleaned up
});

// --- Phase D: getCustomRecipeDetail defensive mapper --------------------------
// LIVE-VERIFIED shape (.international, 2026-06-21): everything nests under recipeContent with
// schema.org keys — recipeIngredient/recipeInstructions (PLAIN STRINGS on read), tool (singular),
// recipeYield{value,unitText}, ISO-8601 durations ("PT5M"). hints is ABSENT from GET (write-only).
// The mapper (asTextList) ALSO tolerates {type,text} objects defensively. These tests pin both:
// the live plain-string read AND the defensive {type,text} unwrap. Guards migrate pass-1 read.

test("getCustomRecipeDetail: unwraps {type,text} objects under recipeContent (defensive)", async () => {
  routeFetch(() =>
    json({
      recipeContent: {
        name: "Suppe",
        recipeIngredient: [{ type: "INGREDIENT", text: "100 g Mehl" }, { type: "INGREDIENT", text: "1 Zwiebel" }],
        recipeInstructions: [{ type: "STEP", text: "Mischen" }],
        tool: ["TM6"],
        totalTime: "PT1H10M", // ISO-8601 → 4200 s
        prepTime: "PT10M",
        recipeYield: { value: 4, unitText: "Portionen" },
      },
    }),
  );
  const d = await getCustomRecipeDetail("01HXYZ");
  expect(d.id).toBe("01HXYZ");
  expect(d.name).toBe("Suppe");
  expect(d.ingredients).toEqual(["100 g Mehl", "1 Zwiebel"]); // unwrapped to plain strings
  expect(d.instructions).toEqual(["Mischen"]);
  expect(d.hints).toBeUndefined(); // never returned by GET
  expect(d.tools).toEqual(["TM6"]);
  expect(d.totalTime).toBe(4200);
  expect(d.prepTime).toBe(600);
  expect(d.yield).toEqual({ value: 4, unitText: "Portionen" });
});

test("getCustomRecipeDetail: maps plain-string arrays under recipeContent (live shape)", async () => {
  routeFetch(() =>
    json({
      recipeContent: {
        name: "Salat",
        recipeIngredient: ["Tomate", "Gurke"], // plain strings, the actual read form
        recipeInstructions: ["Schneiden", "Anrichten"],
      },
    }),
  );
  const d = await getCustomRecipeDetail("01HABC");
  expect(d.name).toBe("Salat");
  expect(d.ingredients).toEqual(["Tomate", "Gurke"]);
  expect(d.instructions).toEqual(["Schneiden", "Anrichten"]);
  expect(d.hints).toBeUndefined(); // absent → undefined, not throw
  expect(d.tools).toBeUndefined();
});

test("getCustomRecipeDetail: THROWS when name is absent (shape changed, not a valid recipe)", async () => {
  routeFetch(() => json({ ingredients: ["x"] }));
  await expect(getCustomRecipeDetail("01HBAD")).rejects.toThrow(/no name/);
});
