#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addToShoppingList,
  addToWeek,
  bookmarkRecipe,
  clearWeek,
  getRecipe,
  getWeekPlan,
  markOwned,
  parseIsoDuration,
  randomRecipe,
  rateRecipe,
  removeFromWeek,
  searchRecipes,
  unbookmarkRecipe,
  unmarkOwned,
} from "./cookidoo.ts";

const server = new McpServer({ name: "cookidoo-mcp", version: "0.1.0" });

server.registerTool(
  "search_recipes",
  {
    title: "Search Cookidoo recipes",
    description: "Search the Cookidoo.de recipe catalog (Algolia-backed). Returns Thermomix recipes with title, total time, rating, category, and URL. Read-only.",
    inputSchema: {
      query: z.string().describe("Search query, e.g. 'Lachs', 'Pasta vegetarisch', 'Hafermilch Pancakes'"),
      hitsPerPage: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
    },
  },
  async ({ query, hitsPerPage }) => {
    const hits = await searchRecipes(query, hitsPerPage ?? 20);
    const summarized = hits.map((h) => ({
      id: h.id,
      title: h.title,
      url: h.url ? `https://cookidoo.de${h.url}` : `https://cookidoo.de/recipes/recipe/de-DE/${h.id}`,
      image: h.image,
      rating: h.rating,
      ratings: h.numberOfRatings,
      totalTimeMin: h.totalTime,
      category: h.category,
      description: h.description?.slice(0, 200),
    }));
    return { content: [{ type: "text", text: JSON.stringify({ total: summarized.length, recipes: summarized }, null, 2) }] };
  },
);

server.registerTool(
  "random_recipe",
  {
    title: "Get a random Cookidoo recipe",
    description: "Returns a random recipe from the Cookidoo catalog. Optionally biased toward a category seed (e.g. 'Pasta', 'Suppe', 'Frühstück'). Useful when no specific keyword is in mind. Returns one RecipeHit (id, title, url, rating, etc).",
    inputSchema: {
      category: z.string().optional().describe("Optional category seed, e.g. 'Pasta', 'Suppe'. If omitted, picks from a built-in basket."),
    },
  },
  async ({ category }) => {
    const hit = await randomRecipe(category);
    const out = {
      id: hit.id,
      title: hit.title,
      url: hit.url ? `https://cookidoo.de${hit.url}` : `https://cookidoo.de/recipes/recipe/de-DE/${hit.id}`,
      image: hit.image,
      rating: hit.rating,
      ratings: hit.numberOfRatings,
      totalTimeMin: hit.totalTime,
      category: hit.category,
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "get_recipe",
  {
    title: "Get a Cookidoo recipe by ID",
    description: "Fetches full recipe detail (ingredients, instructions, times, yield, category, rating) from Cookidoo. Accepts numeric or 'r'-prefixed ID. Parses schema.org JSON-LD from the recipe page.",
    inputSchema: {
      id: z.string().describe("Recipe ID, e.g. 'r807905' or '807905'"),
    },
  },
  async ({ id }) => {
    const r = await getRecipe(id);
    const out = {
      id: r.id,
      url: r.url,
      title: r.title,
      image: r.image,
      description: r.description,
      totalTimeMin: parseIsoDuration(r.totalTime),
      cookTimeMin: parseIsoDuration(r.cookTime),
      prepTimeMin: parseIsoDuration(r.prepTime),
      yield: r.yield,
      category: r.category,
      ingredients: r.ingredients,
      instructions: r.instructions,
      rating: r.rating,
      reviewCount: r.reviewCount,
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "get_week_plan",
  {
    title: "Get current Cookidoo week plan",
    description: "Reads the user's Cookidoo 'Meine Woche' plan. Read-only — does not modify the plan. Defaults to Monday of the current local week and returns dayKeys array with planned recipes per day.",
    inputSchema: {
      startDate: z.string().optional().describe("ISO date YYYY-MM-DD; default Monday of the current local week"),
      span: z.number().int().min(1).max(31).optional().describe("Number of days; default 7"),
    },
  },
  async ({ startDate, span }) => {
    const plan = await getWeekPlan(startDate, span ?? 7);
    return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
  },
);

server.registerTool(
  "add_to_week",
  {
    title: "Add Cookidoo recipes to week plan",
    description: "Adds one or more Cookidoo recipes to a specific Meine Woche day.",
    inputSchema: {
      recipeIds: z.array(z.string()).describe("Recipe IDs, numeric or 'r'-prefixed"),
      dayKey: z.string().describe("Cookidoo day key / ISO date YYYY-MM-DD"),
    },
  },
  async ({ recipeIds, dayKey }) => {
    const result = await addToWeek(recipeIds, dayKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "remove_from_week",
  {
    title: "Remove a Cookidoo recipe from week plan",
    description: "Removes one Cookidoo recipe from a specific Meine Woche day.",
    inputSchema: {
      recipeId: z.string().describe("Recipe ID, numeric or 'r'-prefixed"),
      dayKey: z.string().describe("Cookidoo day key / ISO date YYYY-MM-DD"),
    },
  },
  async ({ recipeId, dayKey }) => {
    const result = await removeFromWeek(recipeId, dayKey);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "clear_week",
  {
    title: "Clear Cookidoo week plan",
    description: "Removes every recipe found in a Cookidoo Meine Woche date span, continuing through per-recipe errors.",
    inputSchema: {
      startDate: z.string().optional().describe("ISO date YYYY-MM-DD; default Monday of the current local week"),
      span: z.number().int().min(1).max(31).optional().describe("Number of days to clear; default 7"),
    },
  },
  async ({ startDate, span }) => {
    const result = await clearWeek(startDate, span);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "add_to_shopping_list",
  {
    title: "Add Cookidoo recipes to shopping list",
    description: "Adds one or more Cookidoo recipes to the shopping list.",
    inputSchema: {
      recipeIds: z.array(z.string()).describe("Recipe IDs, numeric or 'r'-prefixed"),
    },
  },
  async ({ recipeIds }) => {
    const result = await addToShoppingList(recipeIds);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "mark_owned",
  {
    title: "Mark shopping ingredients as owned",
    description: "Marks Cookidoo shopping-list ingredients as already owned.",
    inputSchema: {
      ingredientIds: z.array(z.string()).describe("Cookidoo shopping ingredient IDs"),
    },
  },
  async ({ ingredientIds }) => {
    const result = await markOwned(ingredientIds);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "unmark_owned",
  {
    title: "Unmark a shopping ingredient as owned",
    description: "Removes the owned marker from one Cookidoo shopping-list ingredient.",
    inputSchema: {
      ingredientId: z.string().describe("Cookidoo shopping ingredient ID"),
    },
  },
  async ({ ingredientId }) => {
    const result = await unmarkOwned(ingredientId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "bookmark_recipe",
  {
    title: "Bookmark a Cookidoo recipe",
    description: "Adds a recipe bookmark in Cookidoo.",
    inputSchema: {
      recipeId: z.string().describe("Recipe ID, numeric or 'r'-prefixed"),
    },
  },
  async ({ recipeId }) => {
    const result = await bookmarkRecipe(recipeId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "unbookmark_recipe",
  {
    title: "Unbookmark a Cookidoo recipe",
    description: "Removes a recipe bookmark in Cookidoo.",
    inputSchema: {
      recipeId: z.string().describe("Recipe ID, numeric or 'r'-prefixed"),
    },
  },
  async ({ recipeId }) => {
    const result = await unbookmarkRecipe(recipeId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "rate_recipe",
  {
    title: "Rate a Cookidoo recipe",
    description: "Sets the user's Cookidoo rating for a recipe.",
    inputSchema: {
      recipeId: z.string().describe("Recipe ID, numeric or 'r'-prefixed"),
      rating: z.number().int().min(1).max(5).describe("Rating from 1 to 5"),
    },
  },
  async ({ recipeId, rating }) => {
    const result = await rateRecipe(recipeId, rating);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("cookidoo-mcp started");
