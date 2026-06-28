#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "offers-core";
import { makeHandlers } from "./handlers.ts";

const db = openDb();
const h = makeHandlers(db);
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "groceries-mcp", version: "0.1.0" });

server.registerTool("geocode", {
  title: "Geocode a German address or zip to coordinates",
  description: "Resolves a free-text German address OR a 5-digit zip to {lat, lon, zip, approximate}. A bare zip returns the postcode centroid with approximate:true (coarse). Use before find_stores.",
  inputSchema: { q: z.string().describe("German address or 5-digit zip") },
}, async ({ q }) => text(await h.geocode(q)));

server.registerTool("find_stores", {
  title: "Find nearest supermarket stores to coordinates",
  description: "Returns the nearest stores of a retailer to lat/lon, sorted by straight-line distance, each with its retailer `key` (needed for fetch_offers). Pure lookup — does not fetch offers.",
  inputSchema: {
    retailer: z.string().describe("retailer slug, e.g. lidl, edeka, penny"),
    lat: z.number(), lon: z.number(),
    limit: z.number().int().positive().optional().describe("max stores (default 5)"),
  },
}, async ({ retailer, lat, lon, limit }) => text(await h.findStores(retailer, lat, lon, limit)));

server.registerTool("fetch_offers", {
  title: "Fetch a store's current offers into the local DB",
  description: "Fetches the current weekly offers for a retailer (and store key) from the live retailer API and stores them (append-only). Keyed retailers (lidl, edeka, …) require `key` from find_stores; kaufland is national and ignores key. Call before search_offers.",
  inputSchema: {
    retailer: z.string(),
    key: z.string().optional().describe("store/region key from find_stores; omit for kaufland"),
  },
}, async ({ retailer, key }) => text(await h.fetchOffers(retailer, key)));

server.registerTool("search_offers", {
  title: "Search current offers in the local DB",
  description: "Reads slim offers already fetched into the DB. Filters: retailers, category, priceMin/priceMax (integer cents), foodOnly, q (title search), validOn, weekKey. Returns offers valid today unless a date/week is pinned.",
  inputSchema: {
    retailers: z.array(z.string()).optional(),
    category: z.array(z.string()).optional(),
    priceMin: z.number().int().optional(), priceMax: z.number().int().optional(),
    foodOnly: z.boolean().optional(),
    q: z.string().optional(),
    validOn: z.string().optional(), weekKey: z.string().optional(),
    storeOrRegionKey: z.string().optional(), scope: z.string().optional(),
  },
}, async (args) => text(h.searchOffers(args)));

server.registerTool("get_offer", {
  title: "Get full detail for one offer",
  description: "Returns selected info groups for a single offer by its full composite key (retailer, key, offerId, validFrom). groups: pricing, classification, media, raw, all (default all).",
  inputSchema: {
    retailer: z.string(), key: z.string(), offerId: z.string(), validFrom: z.string(),
    groups: z.array(z.enum(["pricing", "classification", "media", "raw", "all"])).optional(),
  },
}, async ({ retailer, key, offerId, validFrom, groups }) => text(h.getOffer(retailer, key, offerId, validFrom, groups)));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("groceries-mcp started");
