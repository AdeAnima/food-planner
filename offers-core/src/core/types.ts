export type Scope = "store" | "region" | "national";
export type InfoGroup = "pricing" | "classification" | "media" | "raw" | "all";

export interface Offer {
  offerId: string;
  retailer: string;
  scope: Scope;
  storeOrRegionKey: string;
  title: string;
  category: string;
  price: number | null; // integer cents, or null if no absolute price
  quantity?: string;
  unit?: string;
  validFrom: string; // YYYY-MM-DD
  validTo: string;   // YYYY-MM-DD
}

export interface RawOffer {
  offerId: string;
  title: string;
  category: string;
  price: number | null; // integer cents, or null if no absolute price
  quantity?: string;
  unit?: string;
  validFrom: string;
  validTo: string;
  raw: unknown; // full upstream object
}

export interface Store {
  retailer: string;
  storeId: string;
  name: string;
  zip: string;
  lat: number;
  lon: number;
  region: string;
  gln: string;
  scope: Scope;
}
