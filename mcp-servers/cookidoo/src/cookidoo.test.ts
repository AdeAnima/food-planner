import { test, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";

mock.module("./auth.ts", () => ({ loadCookieHeader: async () => "stub=1" }));

let addToWeek: typeof import("./cookidoo.ts").addToWeek;
let getWeekPlan: typeof import("./cookidoo.ts").getWeekPlan;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  ({ addToWeek, getWeekPlan } = await import("./cookidoo.ts"));
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
