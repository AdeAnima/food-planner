#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addAdditionalItems,
  addRecipeIngredients,
  addRecipesToCollection,
  renameCollection,
  addToShoppingList,
  addToWeek,
  BASE,
  bookmarkRecipe,
  clearWeek,
  createCollection,
  createCustomRecipeFull,
  deleteCollection,
  deleteCustomRecipe,
  editAdditionalItemOwnership,
  editAdditionalItems,
  editOwnedIngredients,
  getBookmarks,
  getCollection,
  getCollections,
  getCustomRecipes,
  getCustomRecipeDetail,
  getProfile,
  getRecipe,
  getShoppingList,
  getSubscription,
  getSubscriptionDetail,
  getWeekPlan,
  PATH_LOCALE,
  markOwned,
  parseIsoDuration,
  randomRecipe,
  rateRecipe,
  removeAdditionalItems,
  removeFromWeek,
  removeRecipeFromCollection,
  removeRecipeIngredients,
  renameCustomRecipe,
  searchRecipes,
  setCustomRecipeHints,
  setCustomRecipeIngredients,
  setCustomRecipeInstructions,
  setCustomRecipeMeta,
  setFoodPreferences,
  unbookmarkRecipe,
  unmarkOwned,
  updateProfile,
  migrateAccount,
  MAX_SOURCE_ACCOUNTS,
} from "./core/index.ts";

const server = new McpServer({ name: "cookidoo-mcp", version: "0.1.5" });

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
      url: h.url ? `${BASE}${h.url}` : `${BASE}/recipes/recipe/${PATH_LOCALE}/${h.id}`,
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
      url: hit.url ? `${BASE}${hit.url}` : `${BASE}/recipes/recipe/${PATH_LOCALE}/${hit.id}`,
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
      nutrition: r.nutrition,
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
  "get_shopping_list",
  {
    title: "Get Cookidoo shopping list",
    description: "Reads the current Cookidoo shopping list. Read-only. Returns recipe count, a flat ingredient list (each with its shopping ingredient ID, owned state, quantity, unit, category, and source recipe), and any freeform additional items. The ingredient IDs are what mark_owned / unmark_owned operate on.",
    inputSchema: {},
  },
  async () => {
    const list = await getShoppingList();
    const out = {
      recipeCount: list.recipeCount,
      ingredientCount: list.ingredients.length,
      ingredients: list.ingredients,
      additionalItems: list.additionalItems,
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "get_subscription",
  {
    title: "Get Cookidoo subscription level",
    description: "Returns the account's coarse subscription level (e.g. 'FULL', 'FREE', or 'NONE'), derived from the search token. Read-only, no extra request.",
    inputSchema: {},
  },
  async () => {
    const result = await getSubscription();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "get_subscription_detail",
  {
    title: "Get Cookidoo subscription detail",
    description: "Returns the account's current subscription with level, type, status, start date, and expiry — richer and authoritative vs get_subscription's coarse level. Read-only, one request. Returns null if the account has no subscription record.",
    inputSchema: {},
  },
  async () => {
    const result = await getSubscriptionDetail();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "get_bookmarks",
  {
    title: "Get Cookidoo bookmarks",
    description: "Lists the account's bookmarked (favorited) recipes. Read-only. Returns each bookmark's recipe ID (for get_recipe / unbookmark_recipe), title, image, prep time, and locale. Paginated internally — returns all bookmarks.",
    inputSchema: {},
  },
  async () => {
    const bookmarks = await getBookmarks();
    return { content: [{ type: "text", text: JSON.stringify({ total: bookmarks.length, bookmarks }, null, 2) }] };
  },
);

server.registerTool(
  "get_collections",
  {
    title: "Get Cookidoo collections",
    description: "Lists the account's recipe collections — both user-made custom lists (listType CUSTOMLIST) and followed Vorwerk managed lists (listType MANAGEDLIST). Read-only. Returns each collection's id, title, listType, author, shared flag, and recipe count. Paginated internally.",
    inputSchema: {},
  },
  async () => {
    const collections = await getCollections();
    return { content: [{ type: "text", text: JSON.stringify({ total: collections.length, collections }, null, 2) }] };
  },
);

server.registerTool(
  "get_collection",
  {
    title: "Get one Cookidoo collection's recipes",
    description: "Reads a single custom collection by id and returns its title and the recipe ids it contains. Read-only. Useful before adding/removing recipes.",
    inputSchema: {
      id: z.string().describe("Collection id (from get_collections)"),
    },
  },
  async ({ id }) => {
    const c = await getCollection(id);
    return { content: [{ type: "text", text: JSON.stringify({ id: c.id, title: c.title, recipeCount: c.recipeIds.length, recipeIds: c.recipeIds }, null, 2) }] };
  },
);

server.registerTool(
  "get_custom_recipes",
  {
    title: "Get Cookidoo custom recipes",
    description: "Lists the account's own user-authored recipes (created-recipes). Read-only. Returns each recipe's ULID id, name, status, work status, timestamps, and image. Single request (endpoint returns the full set).",
    inputSchema: {},
  },
  async () => {
    const recipes = await getCustomRecipes();
    return { content: [{ type: "text", text: JSON.stringify({ total: recipes.length, recipes }, null, 2) }] };
  },
);

server.registerTool(
  "get_custom_recipe_detail",
  {
    title: "Get Cookidoo custom recipe detail",
    description: "Reads ONE authored recipe's full content (created-recipes/{id}). Read-only. Returns name, ingredients, instructions, hints, tools, total/prep time, and yield — the fields get_custom_recipes omits. Used to replay a recipe into another account.",
    inputSchema: {
      recipeId: z.string().min(1).describe("Custom recipe id (ULID, from get_custom_recipes)"),
    },
  },
  async ({ recipeId }) => {
    const detail = await getCustomRecipeDetail(recipeId);
    return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
  },
);

server.registerTool(
  "get_profile",
  {
    title: "Get Cookidoo profile",
    description: "Reads the account's community profile. Read-only. Returns id, username, public flag, food preferences, and registered Thermomix count.",
    inputSchema: {},
  },
  async () => {
    const profile = await getProfile();
    return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
  },
);

server.registerTool(
  "add_to_week",
  {
    title: "Add Cookidoo recipes to week plan",
    description: "Adds one or more Cookidoo recipes to a specific Meine Woche day. Idempotent by default — skips recipes already present on that day. Pass force=true to add unconditionally (allows duplicates).",
    inputSchema: {
      recipeIds: z.array(z.string()).describe("Recipe IDs, numeric or 'r'-prefixed"),
      dayKey: z.string().describe("Cookidoo day key / ISO date YYYY-MM-DD"),
      force: z.boolean().optional().describe("Skip dedupe check; add unconditionally"),
    },
  },
  async ({ recipeIds, dayKey, force }) => {
    const result = await addToWeek(recipeIds, dayKey, { force });
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
  "add_additional_items",
  {
    title: "Add freeform items to Cookidoo shopping list",
    description: "Adds one or more freeform (non-recipe) items to the Cookidoo shopping list, e.g. 'Milch', 'Klopapier'. Items are added as not-owned.",
    inputSchema: {
      items: z.array(z.string()).min(1).describe("Freeform item names, e.g. ['Milch', 'Brot']"),
    },
  },
  async ({ items }) => {
    const result = await addAdditionalItems(items);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "edit_additional_items",
  {
    title: "Rename freeform Cookidoo shopping items",
    description: "Renames one or more existing freeform shopping items. Each item is identified by its additional-item id (from get_shopping_list's additionalItems).",
    inputSchema: {
      items: z
        .array(z.object({ id: z.string(), name: z.string() }))
        .min(1)
        .describe("Items to rename: [{id, name}]"),
    },
  },
  async ({ items }) => {
    const result = await editAdditionalItems(items);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "remove_additional_items",
  {
    title: "Remove freeform Cookidoo shopping items",
    description: "Removes one or more freeform shopping items by their additional-item id (from get_shopping_list's additionalItems).",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("Additional-item ids to remove"),
    },
  },
  async ({ ids }) => {
    const result = await removeAdditionalItems(ids);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "edit_additional_item_ownership",
  {
    title: "Set owned state of freeform Cookidoo shopping items",
    description: "Marks freeform shopping items as owned or not-owned. ownedTimestamp defaults to now (unix seconds) when marking owned.",
    inputSchema: {
      items: z
        .array(z.object({ id: z.string(), isOwned: z.boolean(), ownedTimestamp: z.number().int().optional() }))
        .min(1)
        .describe("Items to update: [{id, isOwned, ownedTimestamp?}]"),
    },
  },
  async ({ items }) => {
    const result = await editAdditionalItemOwnership(items);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "edit_owned_ingredients",
  {
    title: "Set owned state of recipe-derived Cookidoo shopping ingredients",
    description: "Bulk-marks recipe-derived shopping ingredients as owned or not-owned. ownedTimestamp defaults to now (unix seconds) when marking owned.",
    inputSchema: {
      items: z
        .array(z.object({ id: z.string().min(1), isOwned: z.boolean(), ownedTimestamp: z.number().int().optional() }))
        .min(1)
        .describe("Ingredients to update: [{id, isOwned, ownedTimestamp?}]"),
    },
  },
  async ({ items }) => {
    const result = await editOwnedIngredients(items);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "add_recipe_ingredients",
  {
    title: "Add recipe ingredients to Cookidoo shopping list",
    description: "Adds the ingredients of one or more recipes to the shopping list via the recipes/add endpoint. Set source to CUSTOMER for the account's own custom recipes (default VORWERK for catalog recipes).",
    inputSchema: {
      recipeIds: z.array(z.string()).min(1).describe("Recipe IDs, numeric or 'r'-prefixed"),
      source: z.enum(["VORWERK", "CUSTOMER"]).optional().describe("Recipe source; default VORWERK"),
    },
  },
  async ({ recipeIds, source }) => {
    const result = await addRecipeIngredients(recipeIds, source ?? "VORWERK");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "remove_recipe_ingredients",
  {
    title: "Remove recipe ingredients from Cookidoo shopping list",
    description: "Removes the ingredients of one or more recipes from the shopping list via the recipes/remove endpoint.",
    inputSchema: {
      recipeIds: z.array(z.string()).min(1).describe("Recipe IDs, numeric or 'r'-prefixed"),
    },
  },
  async ({ recipeIds }) => {
    const result = await removeRecipeIngredients(recipeIds);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "create_collection",
  {
    title: "Create a Cookidoo collection",
    description: "Creates a new user custom collection (custom-list) with the given title. Returns the new collection's id.",
    inputSchema: {
      title: z.string().min(1).describe("Collection title"),
    },
  },
  async ({ title }) => {
    const result = await createCollection(title);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "set_food_preferences",
  {
    title: "Set Cookidoo food preferences",
    description:
      "Sets the profile's food/diet preferences. This REPLACES the entire set — pass the COMPLETE desired list, not a delta. Any preference not included is removed. Read current values with get_profile first if you want to add to them.",
    inputSchema: {
      foodPreferences: z
        .array(z.string())
        .describe("Complete desired set of food preference keys (full replace, not additive)"),
    },
  },
  async ({ foodPreferences }) => {
    const result = await setFoodPreferences(foodPreferences);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "update_profile",
  {
    title: "Update Cookidoo profile",
    description:
      "Updates profile fields (display name and/or picture). Pass only the fields to change. Note: the request body shape is inferred from related endpoints, with an automatic urlencoded fallback if the primary form is rejected — verify the result with get_profile.",
    inputSchema: {
      username: z.string().max(40).optional().describe("New display name"),
      picture: z.string().optional().describe("New picture identifier/URL"),
    },
  },
  async ({ username, picture }) => {
    const fields: { username?: string; picture?: string } = {};
    if (username !== undefined) fields.username = username;
    if (picture !== undefined) fields.picture = picture;
    const result = await updateProfile(fields);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "delete_collection",
  {
    title: "Delete a Cookidoo collection",
    description: "Deletes a user custom collection by id. Only custom lists (CUSTOMLIST) can be deleted, not followed managed lists.",
    inputSchema: {
      id: z.string().describe("Collection id (from get_collections)"),
    },
  },
  async ({ id }) => {
    const result = await deleteCollection(id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "add_recipes_to_collection",
  {
    title: "Add recipes to a Cookidoo collection",
    description: "Adds recipes to a custom collection. Safe against the replace-on-PUT behavior: reads the collection's current recipes and PUTs the union, so existing recipes are preserved. Returns which ids were newly added vs already present.",
    inputSchema: {
      id: z.string().describe("Collection id (from get_collections)"),
      recipeIds: z.array(z.string()).min(1).describe("Recipe IDs to add, numeric or 'r'-prefixed"),
    },
  },
  async ({ id, recipeIds }) => {
    const result = await addRecipesToCollection(id, recipeIds);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "rename_collection",
  {
    title: "Rename a Cookidoo collection",
    description: "Renames a custom collection. Safe against the replace-on-PUT behavior: reads the collection's current recipes and PUTs {title, recipeIds: current}, so membership is preserved. Only custom lists (CUSTOMLIST) can be renamed, not followed managed lists.",
    inputSchema: {
      id: z.string().describe("Collection id (from get_collections)"),
      title: z.string().min(1).describe("New collection title"),
    },
  },
  async ({ id, title }) => {
    const result = await renameCollection(id, title);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "remove_recipe_from_collection",
  {
    title: "Remove a recipe from a Cookidoo collection",
    description: "Removes one recipe from a custom collection by collection id and recipe id.",
    inputSchema: {
      id: z.string().min(1).describe("Collection id (from get_collections)"),
      recipeId: z.string().min(1).describe("Recipe ID, numeric or 'r'-prefixed"),
    },
  },
  async ({ id, recipeId }) => {
    const result = await removeRecipeFromCollection(id, recipeId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "create_custom_recipe",
  {
    title: "Create a Cookidoo custom recipe",
    description:
      "Creates a user custom recipe (created-recipes): POSTs the name, then PATCHes ingredients, instructions, and meta (tools/time/yield). " +
      "NOTE: custom-recipe writes are subscription-gated — they require an account with an active Cookidoo subscription and will return 403 on a lapsed/free account.",
    inputSchema: {
      name: z.string().min(1).describe("Recipe name"),
      ingredients: z.array(z.string()).optional().describe("Ingredient lines as plain text"),
      instructions: z.array(z.string()).optional().describe("Instruction steps as plain text"),
      hints: z.array(z.string()).optional().describe("Tips/hints as plain text"),
      tools: z.array(z.string()).optional().describe("Tools, e.g. ['TM6']"),
      totalTime: z.number().int().optional().describe("Total time in seconds"),
      prepTime: z.number().int().optional().describe("Prep time in seconds"),
      yield: z.object({ value: z.number(), unitText: z.string() }).optional().describe("Yield, e.g. {value:4, unitText:'Portionen'}"),
    },
  },
  async ({ name, ingredients, instructions, hints, tools, totalTime, prepTime, yield: yld }) => {
    const result = await createCustomRecipeFull({ name, ingredients, instructions, hints, tools, totalTime, prepTime, yield: yld });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "edit_custom_recipe",
  {
    title: "Edit a Cookidoo custom recipe",
    description:
      "Edits an existing custom recipe by id. Supply only the fields to change: name, ingredients, instructions, and/or meta (tools/time/yield). " +
      "Subscription-gated like create_custom_recipe (403 on lapsed/free accounts).",
    inputSchema: {
      recipeId: z.string().min(1).describe("Custom recipe id (ULID, from get_custom_recipes)"),
      name: z.string().optional().describe("New name"),
      ingredients: z.array(z.string()).optional().describe("Replacement ingredient lines as plain text"),
      instructions: z.array(z.string()).optional().describe("Replacement instruction steps as plain text"),
      hints: z.array(z.string()).optional().describe("Replacement tips/hints as plain text"),
      tools: z.array(z.string()).optional().describe("Tools, e.g. ['TM6']"),
      totalTime: z.number().int().optional().describe("Total time in seconds"),
      prepTime: z.number().int().optional().describe("Prep time in seconds"),
      yield: z.object({ value: z.number(), unitText: z.string() }).optional().describe("Yield, e.g. {value:4, unitText:'Portionen'}"),
    },
  },
  async ({ recipeId, name, ingredients, instructions, hints, tools, totalTime, prepTime, yield: yld }) => {
    const done: string[] = [];
    if (name !== undefined) {
      await renameCustomRecipe(recipeId, name);
      done.push("name");
    }
    if (ingredients !== undefined) {
      await setCustomRecipeIngredients(recipeId, ingredients);
      done.push("ingredients");
    }
    if (instructions !== undefined) {
      await setCustomRecipeInstructions(recipeId, instructions);
      done.push("instructions");
    }
    if (hints !== undefined) {
      await setCustomRecipeHints(recipeId, hints);
      done.push("hints");
    }
    if (tools !== undefined || totalTime !== undefined || prepTime !== undefined || yld !== undefined) {
      await setCustomRecipeMeta(recipeId, { tools, totalTime, prepTime, yield: yld });
      done.push("meta");
    }
    if (done.length === 0) throw new Error("edit_custom_recipe: no fields to change");
    return { content: [{ type: "text", text: JSON.stringify({ recipeId, updated: done }, null, 2) }] };
  },
);

server.registerTool(
  "delete_custom_recipe",
  {
    title: "Delete a Cookidoo custom recipe",
    description: "Deletes a user custom recipe by id. Subscription-gated like the other custom-recipe writes.",
    inputSchema: {
      recipeId: z.string().describe("Custom recipe id (ULID, from get_custom_recipes)"),
    },
  },
  async ({ recipeId }) => {
    const result = await deleteCustomRecipe(recipeId);
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

server.registerTool(
  "migrate_account",
  {
    title: "Migrate / merge Cookidoo accounts into one",
    description:
      "Merges one or more SOURCE Cookidoo accounts into a TARGET account: recreates every " +
      "custom recipe, then replays bookmarks, collections (merged by name), the week plan, " +
      "shopping-list recipes, and additional items — deduped across sources. Accounts are " +
      "referenced BY NAME; each name resolves to ~/.cookidoo-mcp/accounts/<name>.txt (populate " +
      "with `bun ${CLAUDE_PLUGIN_ROOT}/mcp-servers/cookidoo/src/core/import-state.ts <state.json> --account <name>`), so cookies never pass through the " +
      "tool call. DRY RUN by default: returns the full plan and writes nothing. Pass " +
      "dryRun:false to actually write to the target. Custom recipes are non-idempotent — a " +
      "second live run DUPLICATES them; run once against a fresh target.",
    inputSchema: {
      sourceAccounts: z
        .array(
          z.union([
            z.string(),
            z
              .object({
                account: z.string().describe("Source account name (file under ~/.cookidoo-mcp/accounts/)."),
                useUsername: z
                  .boolean()
                  .optional()
                  .describe("This source supplies the merged username. Only ONE source may set it, else the migration errors."),
                useProfilePicture: z
                  .boolean()
                  .optional()
                  .describe("This source supplies the merged avatar. Only ONE source may set it, else the migration errors."),
                excludeFoodPreferences: z
                  .boolean()
                  .optional()
                  .describe("Drop this source's food preferences from the merged (union) set."),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(MAX_SOURCE_ACCOUNTS)
        .describe(
          `1..${MAX_SOURCE_ACCOUNTS} source accounts to merge (files under ~/.cookidoo-mcp/accounts/). ` +
            "Each entry is a plain account name, or an object {account, useUsername?, useProfilePicture?, " +
            "excludeFoodPreferences?} to steer per-account which unmergeable fields it contributes. Without " +
            "flags: food prefs union all sources, username/picture take the last non-empty. Generic over " +
            "count: 1→1, 2→1, … N→1 all supported.",
        ),
      targetAccount: z.string().describe("Name of the target account to write the merged content into"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Default true. true = return the plan, write nothing. false = execute writes."),
    },
  },
  async ({ sourceAccounts, targetAccount, dryRun }) => {
    const out = await migrateAccount({ sourceAccounts, targetAccount, dryRun });
    // Lead with the human-readable plan; attach the structured result on a live run.
    let text = out.rendered;
    if (!out.dryRun && out.result) {
      // A pass-1 abort leaves non-idempotent custom recipes stranded in the target. Surface the
      // orphan ids loudly ABOVE the JSON so they aren't missed before a (duplicating) re-run.
      if (out.result.aborted) {
        const orphans = out.result.createdRecipes
          .map((r) => (r.uncertain ? `${r.newId} (cleanup unconfirmed)` : r.newId))
          .join(", ") || "(none)";
        // A pass-1 abort happens before pass-2, so only custom recipes can be stranded here.
        text += `\n\n## ⚠️ ABORTED during ${out.result.aborted.phase}\n${out.result.aborted.error}\n` +
          `${out.result.createdRecipes.length} custom recipe(s) were already created in "${targetAccount}" and remain there: ${orphans}\n` +
          `These are NOT idempotent — delete them before retrying, or the re-run will duplicate them.`;
      }
      if (out.result.profileUpdated) text += `\n\nProfile (identity/food-preferences) updated on "${targetAccount}".`;
      text += `\n\n## Execution result\n${JSON.stringify(out.result, null, 2)}`;
    }
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("cookidoo-mcp started");
