import type { Store } from "./types.ts";

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestStore(stores: Store[], lat: number, lon: number): Store | null {
  let best: Store | null = null;
  let bestD = Infinity;
  for (const s of stores) {
    const d = haversineKm({ lat, lon }, { lat: s.lat, lon: s.lon });
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
