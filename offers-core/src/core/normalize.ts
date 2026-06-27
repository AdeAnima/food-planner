import type { InfoGroup } from "./types.ts";

// ponytail: best-effort field-picking over heterogeneous raw shapes. `raw`/`all` are exact;
// pricing/classification/media gather common keys, missing keys are simply absent.
const PRICING_KEYS = ["price", "basePrice", "was", "deposit", "discount", "discountPercent"];
const CLASS_KEYS = ["category", "brand", "labels", "dietary", "tags"];
const MEDIA_KEYS = ["images", "image", "imageUrl", "imageUrls", "flyerPage", "media"];

function pick(raw: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    for (const k of keys) if (k in raw) out[k] = raw[k];
  }
  return out;
}

export function projectGroups(raw: any, groups: InfoGroup[]): Record<string, unknown> {
  const wantAll = groups.includes("all");
  const out: Record<string, unknown> = {};
  if (wantAll || groups.includes("pricing")) out.pricing = pick(raw, PRICING_KEYS);
  if (wantAll || groups.includes("classification")) out.classification = pick(raw, CLASS_KEYS);
  if (wantAll || groups.includes("media")) out.media = pick(raw, MEDIA_KEYS);
  if (wantAll || groups.includes("raw")) out.raw = raw;
  return out;
}
