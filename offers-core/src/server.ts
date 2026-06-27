// src/server.ts
import type { Database } from "bun:sqlite";
import { openDb, getOffers, getOfferDetails, RETAILERS, syncOne } from "./index.ts";
import type { InfoGroup, Scope } from "./core/types.ts";
import { nearestStore } from "./core/stores.ts";
import { weekCount } from "./core/db.ts";
import { isoWeekKey } from "./core/week.ts";

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);
const num = (v: string | null) => { if (v == null || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };

export function makeApp(db: Database) {
  return async function app(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.searchParams;

    if (req.method === "GET" && url.pathname === "/offers") {
      const rows = getOffers(db, {
        retailers: csv(p.get("retailers")),
        scope: (p.get("scope") ?? undefined) as Scope | undefined,
        storeOrRegionKey: p.get("storeOrRegionKey") ?? undefined,
        category: csv(p.get("category")),
        priceMin: num(p.get("priceMin")),
        priceMax: num(p.get("priceMax")),
        validOn: p.get("validOn") ?? undefined,
        weekKey: p.get("weekKey") ?? undefined,
        foodOnly: p.get("foodOnly") === "true" ? true : undefined,
        q: p.get("q") ?? undefined,
      });
      return Response.json(rows);
    }

    const detail = url.pathname.match(/^\/offers\/(.+)$/);
    if (req.method === "GET" && detail) {
      const offerId = decodeURIComponent(detail[1]);
      const retailer = p.get("retailer") ?? "";
      const storeOrRegionKey = p.get("storeOrRegionKey") ?? "";
      const validFrom = p.get("validFrom") ?? "";
      const groups = (csv(p.get("groups")) ?? ["all"]) as InfoGroup[];
      const d = getOfferDetails(db, retailer, storeOrRegionKey, offerId, validFrom, groups);
      return d ? Response.json(d) : new Response("not found", { status: 404 });
    }

    if (req.method === "GET" && url.pathname === "/stores") {
      const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
      const names = csv(p.get("retailers")) ?? Object.keys(RETAILERS);
      const out: any[] = [];
      for (const name of names) {
        const r = (RETAILERS as any)[name];
        // ponytail: only lidl has a geo store-fn (city,lat,lon). edeka.stores is zip-keyed
        // (edekaMarkets(zip)) — geo lookup for it needs a zip resolved upstream (offers-mcp/CLI).
        if (r?.stores && name === "lidl") {
          try {
            const stores = await r.stores("", lat, lon);
            out.push({ retailer: name, nearest: nearestStore(stores, lat, lon) });
          } catch (e) {
            out.push({ retailer: name, scope: r.scope, error: (e as Error).message });
          }
        } else {
          // edeka (zip-keyed), penny (region), national/marktguru/rewe — no geo nearest here
          out.push({ retailer: name, scope: r?.scope ?? "national" });
        }
      }
      return Response.json(out);
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      const names = csv(p.get("retailers")) ?? ["kaufland"];
      const out: any[] = [];
      // ponytail: kaufland-only. Only kauflandOffers() is zero-arg; lidl/edeka/penny/rewe/marktguru
      // each need a resolved key/zip/terms (heterogeneous arities). Narrowing concretely on kaufland
      // keeps tsc honest (no `as any` masking an undefined-key fetch) — keyed sync is the offers-mcp layer.
      for (const name of names) {
        if (name === "kaufland") {
          const wk = isoWeekKey(new Date().toISOString().slice(0, 10));
          // ponytail: prev = THIS week's count (anomaly best-effort per T14 forward-flag).
          const prev = weekCount(db, "kaufland", "national", wk);
          out.push(await syncOne(
            db, "kaufland", "national", RETAILERS.kaufland.scope, RETAILERS.kaufland.offers, wk, prev,
          ).catch((e: Error) => ({ retailer: name, error: e.message })));
        } else {
          out.push({ retailer: name, error: "needs key resolution (offers-mcp layer)" });
        }
      }
      return Response.json(out);
    }

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const db = openDb();
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: makeApp(db) });
  console.log(`offers-core server on :${port}`);
}
