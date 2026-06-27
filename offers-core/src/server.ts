// src/server.ts
import type { Database } from "bun:sqlite";
import { openDb, getOffers, getOfferDetails } from "./index.ts";
import type { InfoGroup, Scope } from "./core/types.ts";

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined);
const num = (v: string | null) => (v != null ? Number(v) : undefined);

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

    // /stores and POST /sync — Task 17 (nearestStore from core/stores.ts)

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const db = openDb();
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: makeApp(db) });
  console.log(`offers-core server on :${port}`);
}
