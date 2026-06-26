#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchOffers, getWeeklyOffers, listStores, type Offer } from "./marktguru.ts";
import { findStoresNearby, geocodeAddress, resolveZipFromInput } from "./geocode.ts";

const server = new McpServer({ name: "supermarkets-mcp", version: "0.1.0" });

function summarizeOffer(o: Offer) {
  const adv = o.advertisers?.[0];
  return {
    id: o.id,
    // product.name is the clean canonical product label (populated on live offers);
    // description is a marketing sub-line ("aus Bayern, Kl. I Stück") that omits the
    // product word, so it must never be the primary match/display field.
    title: o.product?.name || o.description?.slice(0, 80),
    productName: o.product?.name ?? null,
    category: o.categories?.[0]?.name ?? null,
    description: o.description,
    price: o.price,
    oldPrice: o.oldPrice,
    referencePrice: o.referencePrice,
    retailer: adv?.uniqueName ?? null,
    retailerName: adv?.name ?? null,
    brand: o.brand?.name ?? null,
    validFrom: o.validityDates?.[0]?.from ?? null,
    validUntil: o.validityDates?.[0]?.to ?? o.validityDates?.[0]?.until ?? null,
    image: o.images?.urls?.medium ?? o.images?.urls?.small ?? null,
  };
}

server.registerTool(
  "list_stores",
  {
    title: "List supported supermarket retailers",
    description: "Returns the list of retailer slugs available for a German ZIP code or address. Probes the live API filters facet, falls back to hardcoded list.",
    inputSchema: {
      zipCode: z.string().optional().describe("German ZIP code (5 digits). Default 80331 if neither zipCode nor address given."),
      address: z.string().optional().describe("Free-text German address (alternative to zipCode). Geocoded via OSM Nominatim."),
    },
  },
  async ({ zipCode, address }) => {
    let resolvedZip = "80331";
    if (zipCode || address) {
      const resolved = await resolveZipFromInput({ zipCode, address });
      resolvedZip = resolved.zipCode;
    }
    const stores = await listStores(resolvedZip);
    return { content: [{ type: "text", text: JSON.stringify({ zipCode: resolvedZip, stores }, null, 2) }] };
  },
);

server.registerTool(
  "search_offers",
  {
    title: "Search current weekly supermarket offers by keyword",
    description: "Search current weekly supermarket offers by keyword. Returns matching offers with prices, store names, and validity dates. Accepts either zipCode (5 digits) or address (geocoded via OSM).",
    inputSchema: {
      query: z.string().min(1).describe("Search keyword, e.g. 'Lachs', 'Hafermilch', 'Pasta'"),
      zipCode: z.string().optional().describe("German ZIP code (5 digits)"),
      address: z.string().optional().describe("Free-text German address (alternative to zipCode)"),
      stores: z.string().optional().describe("Comma-separated retailer slugs to filter, e.g. 'lidl,rewe'"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    },
  },
  async ({ query, zipCode, address, stores, limit }) => {
    if (!query.trim()) throw new Error("query is required and must be non-empty");
    const resolved = await resolveZipFromInput({ zipCode, address });
    const storeList = stores ? stores.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const resp = await searchOffers({ query, zipCode: resolved.zipCode, stores: storeList, limit: limit ?? 20 });
    const summarized = resp.results.map(summarizeOffer);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          zipCode: resolved.zipCode,
          total: resp.totalResults ?? summarized.length,
          offers: summarized,
        }, null, 2),
      }],
    };
  },
);

server.registerTool(
  "get_weekly_offers",
  {
    title: "Get current weekly offers for a basket of terms",
    description: "Fans out parallel searches over a basket of food terms (default = pescetarian basket) and merges deduplicated, currently-valid offers. If fewer than half of term searches fail, returns partial results with degraded:true and failedTerms; if half or more fail, the tool fails. Marktguru does not expose a catalog-wide dump, so this is the closest equivalent. Pass `terms` to override the default basket. Accepts either zipCode or address.",
    inputSchema: {
      zipCode: z.string().optional().describe("German ZIP code (5 digits)"),
      address: z.string().optional().describe("Free-text German address (alternative to zipCode)"),
      stores: z.string().optional().describe("Comma-separated retailer slugs, e.g. 'lidl,rewe'"),
      terms: z.string().optional().describe("Comma-separated search terms (default: built-in pescetarian basket)"),
      perTermLimit: z.number().int().min(1).max(50).optional().describe("Max offers per term (default 20)"),
    },
  },
  async ({ zipCode, address, stores, terms, perTermLimit }) => {
    const resolved = await resolveZipFromInput({ zipCode, address });
    const storeList = stores ? stores.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const termList = terms ? terms.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const resp = await getWeeklyOffers(resolved.zipCode, storeList, termList, perTermLimit ?? 20);
    const summarized = resp.results.map(summarizeOffer);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          zipCode: resolved.zipCode,
          total: summarized.length,
          degraded: resp.degraded ?? false,
          failedTerms: resp.failedTerms ?? [],
          offers: summarized,
        }, null, 2),
      }],
    };
  },
);

server.registerTool(
  "geocode_address",
  {
    title: "Geocode a German address to lat/lng/zip",
    description: "Resolves a free-text German address to coordinates and postcode via OpenStreetMap Nominatim. Cached for 30 days locally. Use to translate address-only user input into a zip code for offer search.",
    inputSchema: {
      address: z.string().min(1).describe("Free-text address, e.g. 'Marienplatz 1, München'"),
    },
  },
  async ({ address }) => {
    const geo = await geocodeAddress(address);
    return { content: [{ type: "text", text: JSON.stringify(geo, null, 2) }] };
  },
);

server.registerTool(
  "find_stores_nearby",
  {
    title: "Find supermarkets near an address",
    description: "Lists supermarkets within radiusKm of an address using OpenStreetMap (amenity=shop=supermarket/discount_supermarket via Overpass). Each store includes name, distance (km, haversine), and a best-effort Marktguru retailer slug for cross-referencing with offer data. Cached 7 days locally per (lat,lon,radius). Use to plan a shopping route that balances offer savings vs travel distance.",
    inputSchema: {
      address: z.string().min(1).describe("Free-text German address"),
      radiusKm: z.number().min(0.1).max(50).optional().describe("Search radius in km (default 3)"),
    },
  },
  async ({ address, radiusKm }) => {
    const geo = await geocodeAddress(address);
    const stores = await findStoresNearby(geo.lat, geo.lon, radiusKm ?? 3);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          origin: { address: geo.displayName, lat: geo.lat, lon: geo.lon, zipCode: geo.zipCode },
          radiusKm: radiusKm ?? 3,
          total: stores.length,
          stores,
        }, null, 2),
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("supermarkets-mcp started");
