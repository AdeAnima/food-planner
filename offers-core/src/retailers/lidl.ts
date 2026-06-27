// src/retailers/lidl.ts
import type { RawOffer, Store } from "../core/types.ts";

const HDR = { "Accept-Language": "de-DE" };

export async function lidlStores(city: string, lat: number, lon: number): Promise<Store[]> {
  const url = `https://stores.lidlplus.com/api/v1/autocomplete/DE?input=${encodeURIComponent(city)}&language=de&latitude=${lat}&longitude=${lon}`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) throw new Error(`lidl autocomplete ${res.status}`);
  const arr = (await res.json()) as any[];
  return arr.map((s) => ({
    retailer: "lidl",
    storeId: s.storeKey,
    name: s.name ?? city,
    zip: s.postalCode ?? "",
    lat: s.location?.latitude ?? lat,
    lon: s.location?.longitude ?? lon,
    region: s.storeKey,
    gln: "",
    scope: "region" as const,
  }));
}

export async function lidlOffers(storeKey: string): Promise<RawOffer[]> {
  const res = await fetch(`https://offers.lidlplus.com/app/api/v4/DE/${storeKey}/offers`, { headers: HDR });
  if (!res.ok) throw new Error(`lidl offers ${res.status}`);
  const data = (await res.json()) as any;
  return (data.offers ?? []).map(normalizeLidl);
}

export function normalizeLidl(raw: any): RawOffer {
  // Price lives in priceBox.largePartNumeric (euros, float). Percentage-off offers have null — emit null.
  const lpn = raw.priceBox?.largePartNumeric;
  const p = Number(lpn);
  const cents = (Number.isFinite(p) && p > 0) ? Math.round(p * 100) : null;

  // Dates are ISO 8601 with timezone offset: "2026-06-25T00:00:01+00:00" — slice(0,10) gives YYYY-MM-DD.
  return {
    offerId: String(raw.id ?? raw.offerId),
    title: String(raw.title ?? raw.brand ?? "").trim(),
    category: String(raw.category ?? "Sonstiges"),
    price: cents,
    quantity: raw.packaging ?? undefined,
    unit: raw.pricePerUnit ?? undefined,
    validFrom: isoDate(raw.startValidityDate),
    validTo: isoDate(raw.endValidityDate),
    raw,
  };
}

function isoDate(s: string | undefined): string {
  if (!s) return "1970-01-01";
  return s.slice(0, 10);
}
