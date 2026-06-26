import type { RawOffer } from "../core/types.ts";

const KAUFLAND_OFFERS_URL =
  "https://filiale.kaufland.de/angebote/uebersicht.html?kloffer-category=0001_TopArticle&kloffer-week=current";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Exactly one window.SSR[...] = {...}; </script> block. [\s\S]*? spans newlines (the JSON has them).
const SSR_RE = /window\.SSR\[[^\]]+\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;

export function normalizeKaufland(o: any, dateFrom: string, dateTo: string): RawOffer {
  const p = Number(o.price);
  const cents = (Number.isFinite(p) && p > 0) ? Math.round(p * 100) : null;
  return {
    offerId: String(o.offerId),
    title: String(o.title ?? "").trim(),
    category: "Sonstiges", // Kaufland offers carry no category (v2 offer_tags work)
    price: cents,
    quantity: o.unit ? String(o.unit) : undefined, // `unit` is the free-text quantity descriptor
    unit: undefined,
    validFrom: String(dateFrom ?? "").slice(0, 10) || "1970-01-01",
    validTo: String(dateTo ?? "").slice(0, 10) || "1970-01-01",
    raw: o,
  };
}

export function parseKaufland(html: string): RawOffer[] {
  const m = html.match(SSR_RE);
  if (!m) throw new Error("kaufland: SSR block not found");
  const obj = JSON.parse(m[1]); // corrupt page => throws, intentional hard fail
  const cycles = obj?.props?.offerData?.cycles ?? [];
  const out: RawOffer[] = [];
  for (const cycle of cycles) {
    for (const category of cycle.categories ?? []) {
      for (const o of category.offers ?? []) {
        out.push(normalizeKaufland(o, o.dateFrom, o.dateTo));
      }
    }
  }
  return out;
}

export async function kauflandOffers(): Promise<RawOffer[]> {
  const res = await fetch(KAUFLAND_OFFERS_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`kaufland offers ${res.status}`);
  return parseKaufland(await res.text());
}
