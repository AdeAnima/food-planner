// src/sync.ts — one-shot CLI sync (cron-friendly; mirrors POST /sync without a running server)
// Usage: bun run sync [retailers]   e.g. `bun run sync` (kaufland) or `bun run sync kaufland`
// ponytail: kaufland-only. lidl/edeka/penny/rewe/marktguru.offers() each need a resolved
// key/zip/terms (heterogeneous arities) — keyed multi-retailer sync is the offers-mcp layer's job.
import { openDb, RETAILERS, syncOne } from "./index.ts";
import { weekCount } from "./core/db.ts";
import { isoWeekKey } from "./core/week.ts";

const names = (process.argv[2]?.split(",").filter(Boolean)) ?? ["kaufland"];
const db = openDb();
const wk = isoWeekKey(new Date().toISOString().slice(0, 10));

const out: unknown[] = [];
for (const name of names) {
  if (name === "kaufland") {
    const prev = weekCount(db, "kaufland", "national", wk);
    out.push(await syncOne(
      db, "kaufland", "national", RETAILERS.kaufland.scope, RETAILERS.kaufland.offers, wk, prev,
    ).catch((e: Error) => ({ retailer: name, error: e.message })));
  } else {
    out.push({ retailer: name, error: "needs key resolution (offers-mcp layer)" });
  }
}
console.log(JSON.stringify(out, null, 2));
