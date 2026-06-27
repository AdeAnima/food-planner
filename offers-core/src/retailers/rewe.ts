import type { RawOffer } from "../core/types.ts";

// ponytail: deferred — mTLS path (cert from APK, res/raw/mtls_prod.pfx) not yet verified live. v1 falls back to Marktguru.
// When enabling: fetch(url, { tls: { cert, key } }) with REWE_CERT / REWE_KEY env (PEM extracted from mtls_prod.pfx).
export async function reweOffers(_plz: string): Promise<RawOffer[]> {
  throw new Error("REWE client deferred / not implemented — use Marktguru zip fallback");
}
