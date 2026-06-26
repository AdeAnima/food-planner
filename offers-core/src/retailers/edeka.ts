import type { RawOffer, Store } from "../core/types.ts";

let cachedToken: { value: string; exp: number } | null = null;

export async function edekaToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 5000) return cachedToken.value;
  const id = process.env.EDEKA_CLIENT_ID;
  const secret = process.env.EDEKA_CLIENT_SECRET;
  if (!id || !secret) throw new Error("EDEKA_CLIENT_ID / EDEKA_CLIENT_SECRET unset");
  const res = await fetch("https://b2b-login.api.edeka/auth/realms/b2b/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${id}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`edeka token ${res.status}`);
  const j = (await res.json()) as any;
  cachedToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 360) * 1000 };
  return cachedToken.value;
}

export async function edekaMarkets(zip: string): Promise<Store[]> {
  const t = await edekaToken();
  const res = await fetch(`https://b2c-gw.api.edeka/v3/markets?zipCode=${zip}&size=20&page=0`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`edeka markets ${res.status}`);
  const j = (await res.json()) as any;
  return (j.markets ?? j.content ?? []).map((m: any) => ({
    retailer: "edeka",
    storeId: String(m.id ?? m.gln),
    name: m.name ?? "Edeka",
    zip: m.contact?.address?.city?.zipCode ?? zip,
    lat: m.coordinates?.latitude ?? 0,
    lon: m.coordinates?.longitude ?? 0,
    region: "",
    gln: String(m.gln),
    scope: "store" as const,
  }));
}

export async function edekaOffers(gln: string): Promise<RawOffer[]> {
  const t = await edekaToken();
  const res = await fetch(`https://b2c-gw.api.edeka/v2/offers/mobile?marketGln=${gln}&size=200&page=0&sortedByCategory=true`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`edeka offers ${res.status}`);
  const j = (await res.json()) as any;
  return (j.offers ?? []).map(normalizeEdeka);
}

export function normalizeEdeka(raw: any): RawOffer {
  const rv = Number(raw.price?.rawValue);
  const cents = (raw.priceType === "SHOW" && rv > 0) ? Math.round(rv * 100) : null;
  return {
    offerId: String(raw.id ?? raw.offerId),
    title: String(raw.title ?? "").trim(),
    category: "Sonstiges",
    price: cents,
    quantity: undefined,
    unit: undefined,
    validFrom: String(raw.validFrom ?? "").slice(0, 10) || "1970-01-01",
    validTo: String(raw.validTill ?? raw.validTo ?? "").slice(0, 10) || "1970-01-01",
    raw,
  };
}
