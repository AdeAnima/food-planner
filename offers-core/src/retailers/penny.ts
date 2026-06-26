import type { RawOffer } from "../core/types.ts";

const PENNY = "https://www.penny.de/.rest";
// Penny food category slugs (the per-category endpoint requires a slug, not a number).
// Confirmed valid against live /angebote SSR (2026-26). Seasonal/non-food slugs rotate
// weekly and are deliberately excluded; the food core below is stable.
// ponytail: hardcoded list, derive from /angebote data-category-id if core slugs ever rotate.
const DEFAULT_CATEGORIES = [
  "top-angebote",
  "obst-und-gemuese",
  "kuehlregal",
  "fleisch-und-wurst",
  "getraenke",
  "suessigkeiten-und-snacks",
  "drogerie-und-haushalt",
];

function currentWeekKey(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((t.getTime() - ys.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-${String(wk).padStart(2, "0")}`;
}

function weekToDates(weekKey: string): { from: string; to: string } {
  const [y, w] = weekKey.split("-").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const mon = new Date(week1Mon);
  mon.setUTCDate(week1Mon.getUTCDate() + (w - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

export async function pennyRegion(zip: string): Promise<string> {
  const res = await fetch(`${PENNY}/market`);
  if (!res.ok) throw new Error(`penny market ${res.status}`);
  const markets = (await res.json()) as any[];
  const m =
    markets.find((x) => String(x.zipCode) === zip) ??
    markets.find((x) => String(x.zipCode).startsWith(zip.slice(0, 2)));
  if (!m) throw new Error(`penny: no region for zip ${zip}`);
  return String(m.sellingRegion);
}

export async function pennyOffers(region: string, categories: string[] = DEFAULT_CATEGORIES): Promise<RawOffer[]> {
  const weekKey = currentWeekKey();
  const out: RawOffer[] = [];
  let ok = 0;
  for (const slug of categories) {
    const res = await fetch(`${PENNY}/offers/by-category/${weekKey}/${slug}?region=${region}`);
    if (res.status === 404) continue; // category absent this week — tolerate, keep going
    if (!res.ok) throw new Error(`penny offers ${slug}: ${res.status}`); // 5xx/wrong-region = real failure
    ok++;
    const data = (await res.json()) as any;
    for (const tile of data.offerTiles ?? []) {
      if (tile.primaryType !== "offer") continue;
      const o = normalizePenny(tile, weekKey);
      o.category = slug; // category = the queried slug (tile has no category field)
      out.push(o);
    }
  }
  // Zero successful fetches = bad region/all-404 — empty [] would be indistinguishable from "no offers".
  if (ok === 0) throw new Error(`penny offers: no category succeeded for region ${region} week ${weekKey}`);
  return out;
}

export function normalizePenny(tile: any, weekKey: string): RawOffer {
  const rv = Number(tile.price);
  const cents = (Number.isFinite(rv) && rv > 0) ? Math.round(rv * 100) : null;
  const { from, to } = weekToDates(weekKey);
  return {
    offerId: String(tile.uuid),
    title: String(tile.title ?? "").trim(),
    category: "Sonstiges", // overwritten with slug by pennyOffers; default for direct calls
    price: cents,
    quantity: tile.quantity ? String(tile.quantity) : undefined,
    unit: undefined,
    validFrom: from,
    validTo: to,
    raw: tile,
  };
}
