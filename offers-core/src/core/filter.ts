export const NON_FOOD_CATEGORIES = [
  "Drogerie", "Haushalt", "Garten", "Technik", "Spielzeug", "Kleidung", "Tierbedarf",
];

export interface OfferQuery {
  retailers?: string[];
  scope?: string;
  storeOrRegionKey?: string;
  category?: string[];
  priceMin?: number;
  priceMax?: number;
  validOn?: string;
  weekKey?: string;
  foodOnly?: boolean;
  q?: string;
}

export function buildWhere(query: OfferQuery): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (query.retailers?.length) {
    clauses.push(`retailer IN (${query.retailers.map(() => "?").join(",")})`);
    params.push(...query.retailers);
  }
  if (query.scope) { clauses.push("scope = ?"); params.push(query.scope); }
  if (query.storeOrRegionKey) { clauses.push("storeOrRegionKey = ?"); params.push(query.storeOrRegionKey); }
  if (query.category?.length) {
    clauses.push(`category IN (${query.category.map(() => "?").join(",")})`);
    params.push(...query.category);
  }
  if (query.priceMin != null) { clauses.push("price >= ?"); params.push(query.priceMin); }
  if (query.priceMax != null) { clauses.push("price <= ?"); params.push(query.priceMax); }
  if (query.validOn) {
    clauses.push("validFrom <= ? AND validTo >= ?");
    params.push(query.validOn, query.validOn);
  }
  if (query.weekKey) { clauses.push("weekKey = ?"); params.push(query.weekKey); }
  if (query.foodOnly) {
    clauses.push(`category NOT IN (${NON_FOOD_CATEGORIES.map(() => "?").join(",")})`);
    params.push(...NON_FOOD_CATEGORIES);
  }
  if (query.q) { clauses.push("title LIKE ?"); params.push(`%${query.q}%`); }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", params };
}
