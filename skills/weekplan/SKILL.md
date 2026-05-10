---
name: weekplan
description: Use when user runs /weekplan or asks to "plan the week", "make the meal plan", "do the weekly grocery plan". Generates a 7-day Cookidoo meal plan + per-store shopping list using current Marktguru offers + the user's diet profile from ~/.weekplan/profile.json. Geocodes the user's address to find nearby supermarkets, balances offer-savings vs travel-distance, and writes the plan directly to Cookidoo's "Meine Woche" + shopping list. Outputs to ~/.weekplan/plans/<YYYY-MM-DD>/. Supports unattended/auto mode for scheduled runs.
---

# /weekplan — Weekly meal plan + shopping list

## Purpose

End-to-end pipeline: load profile → geocode → current supermarket offers → Cookidoo recipe selection → diet-constrained 7-day plan → per-store shopping list grouped by aisle + walking-distance route. Writes recipes directly to Cookidoo "Meine Woche" + shopping list via cookidoo-mcp write tools. Persists every weekly plan to disk under `~/.weekplan/plans/<YYYY-MM-DD>/`.

## Modes

- **Interactive (default)** — ask cadence question, ask whether to extend/replace existing plan, surface clarifying questions when ambiguous.
- **Auto / unattended** — triggered by ANY of: argv contains `--auto`, env `WEEKPLAN_AUTO=1`, prompt contains "auto" / "unattended" / "scheduled" / "non-interactive" / "without asking" / "no questions". In auto mode: NEVER call AskUserQuestion. Use defaults from profile.json. Always REPLACE existing plan (call `clear_week` first). Auto mode must complete with no user-facing prompts.

## Inputs

### Profile — `~/.weekplan/profile.json`

Single source of truth. Schema: `profile.schema.json` in this skill folder. Example: `profile.example.json`.

Key fields:
- `household.size`, `household.portionsPerMeal`
- `location.address` (preferred) or `location.zipCode`; `location.shoppingRadiusKm`
- `diet.type` (`omnivore`/`pescetarian`/`vegetarian`/`vegan`), `diet.lowHistamine`, `diet.preferVeganDairyAlternatives`
- `diet.forbidden[]` — case-insensitive substring matches in ingredient text
- `diet.flaggedButAllowed[]` — surface in Notes section but do not drop
- `preferences.cadenceDefault` — `dinner-only` or `lunch-and-dinner`
- `preferences.preferredStores[]` — Marktguru retailer slugs
- `preferences.maxRecipesPerWeek`, `preferences.maxSameProteinPerWeek`

Read every run via `Read` tool on `~/.weekplan/profile.json`. If missing or invalid JSON, abort with copy-paste instructions to create from `profile.example.json`.

### Cadence

Interactive: confirm `preferences.cadenceDefault` is right for this week ("Diese Woche: nur Abendessen, oder Mittag + Abend?"). Default = profile setting. Auto: use profile setting silently.

### Existing week plan

Call `mcp__cookidoo__get_week_plan` first. Defaults to Monday of current local week. Interactive: if non-empty, ask whether to extend or replace (replace = call `clear_week`). Auto: replace silently via `clear_week`.

## Outputs — `~/.weekplan/plans/<YYYY-MM-DD>/`

`<YYYY-MM-DD>` = Monday of the target week (ISO date). Files written each run:

| File | Contents |
|------|----------|
| `plan.md` | Markdown plan: header + daily table + Cookidoo confirmation |
| `shopping-list.md` | Per-store shopping list, aisle-grouped, with walking-route hint |
| `offers.json` | Snapshot of the Marktguru offers used (frozen, for later audit) |
| `recipes.json` | Snapshot of recipe IDs + titles + chosen day keys |

Write order: build full content in memory → write all 4 files atomically near the end of the pipeline. Auto mode also prints `plan.md` to chat.

## Pipeline

### 1. Load profile + resolve location
- Read `~/.weekplan/profile.json`. Abort cleanly if missing.
- If `location.address` set: call `mcp__supermarkets-mcp__geocode_address(address)` to get lat/lon + zip. Use that zip for offer queries.
- Else use `location.zipCode` directly.
- Call `mcp__supermarkets-mcp__find_stores_nearby(address, radiusKm=location.shoppingRadiusKm)`. Cache result for use in step 8.

### 2. Determine target meals
- `dinner-only`: 7 dinners. Lunch = previous-night leftovers (low-histamine: leftovers ≤24h, eaten next day cold or warmed once).
- `lunch-and-dinner`: 14 meals; design overlap explicitly (e.g., big-batch curry → 4 meals across 2 days).

### 3. Fetch supermarket offers
Call `mcp__supermarkets-mcp__get_weekly_offers` with `address` (or `zipCode`) from profile, `stores=preferences.preferredStores`. Default basket OR override based on user signals (e.g. "lust auf Asia" → asian terms).

### 4. Apply diet hard-filters to offers
Drop offers whose `description` or `title` contain any string from `profile.diet.forbidden[]` (case-insensitive).

Special rules when `diet.lowHistamine == true`:
- All matches in `forbidden[]` already cover the histamine triggers — no extra logic.
- If `forbidden[]` is empty but `lowHistamine == true`, fall back to the built-in low-histamine list (see profile.example.json for the default set).

Vegan dairy alternatives PREFERRED when `preferVeganDairyAlternatives == true`: prioritize oat/almond/coconut milk; if no vegan alt in offers, lactose-free dairy acceptable — surface in Notes.

### 5. Search Cookidoo for recipes matching offers
For top ~15 offer ingredients (post-filter), call `mcp__cookidoo__search_recipes` per ingredient. Aggregate ~50-80 candidates.

If profile is missing or returns no usable offers, fall back to `mcp__cookidoo__random_recipe` (seeded with category from profile or default basket) to fill gaps — flag in Notes.

For each candidate, call `mcp__cookidoo__get_recipe` for full ingredient list. Parallelize via Promise.all in a single tool batch.

### 6. Apply diet hard-filters to recipes
Drop recipes whose ingredients contain any `diet.forbidden[]` string. Flag (don't drop) items in `diet.flaggedButAllowed[]`.

### 7. Optimize for low waste — ingredient overlap
Build ingredient frequency map. Greedy assembly: pick highest-rated recipe whose ingredient set maximizes overlap with already-chosen meals AND uses ≥1 offer ingredient. Diversity guard: at most `preferences.maxSameProteinPerWeek` of the same primary protein in 7 days.

### 8. Write plan to Cookidoo
For each chosen recipe + dayKey (YYYY-MM-DD, Mon-Sun of target week):
- `mcp__cookidoo__add_to_week({recipeIds: [id], dayKey})`
- `mcp__cookidoo__add_to_shopping_list({recipeIds: [id]})` (covers all ingredients)

Write order:
1. Auto mode: `mcp__cookidoo__clear_week({})` first to wipe existing plan.
2. Interactive replace: same as auto.
3. Interactive extend: skip clear, just add new recipes alongside existing.

If `add_to_week` fails per-recipe, log and continue — don't abort whole pipeline. Surface failures in `plan.md` Notes section.

### 9. Build shopping list — cost vs distance
For each ingredient across the 7 plans:
1. Look up the offer (if any) that matched it in step 4 → preferred retailer slug.
2. Find that retailer in the `find_stores_nearby` result → distance.
3. Compute savings = (regular price − offer price) × quantity.
4. Group ingredients per store. If a store contributes < 2 € savings and is > 1 km farther than the primary store, consolidate to the primary store (use the primary's regular price — flag in Notes).
5. Primary store = closest of `preferences.preferredStores` from the nearby list.
6. Group within each store by aisle: produce / dairy-alt / fish / pantry / frozen / bakery.
7. Quantity per ingredient: sum across recipes, scale to `household.portionsPerMeal`.

Output a walking route hint at the top of `shopping-list.md`: stores ordered by distance from origin.

### 10. Write files + chat output

Markdown plan structure (`plan.md`):
- **Header**: week range (Mon-Sun), meal count, total estimated cost from offer prices, total estimated savings, "✓ N recipes added to Cookidoo Meine Woche"
- **Daily plan table**: | Day | Dinner (recipe + URL) | Lunch (leftover / new) |
- **Cookidoo confirmation**: "Plan added to Cookidoo. Open https://cookidoo.de/planning/de-DE to view." (no manual handoff URLs unless writes failed)
- **Notes**: flagged-but-allowed recipes, allergy reminders, any `add_to_week` write failures, consolidation decisions

`shopping-list.md`:
- **Route hint**: stores in distance order from origin
- **Per-store sections** with aisle subgroups + quantities

Auto mode: also print `plan.md` to chat. Final line: `WEEKPLAN_AUTO_DONE <output-file-path>` for scheduler detection.

## MCP tool inventory

### supermarkets-mcp (read-only)
- `mcp__supermarkets-mcp__list_stores({zipCode?, address?})` — discover retailers
- `mcp__supermarkets-mcp__search_offers({query, zipCode?, address?, stores?, limit?})` — keyword search
- `mcp__supermarkets-mcp__get_weekly_offers({zipCode?, address?, stores?, terms?, perTermLimit?})` — fan-out basket search
- `mcp__supermarkets-mcp__geocode_address({address})` — address → lat/lon/zip
- `mcp__supermarkets-mcp__find_stores_nearby({address, radiusKm?})` — OSM supermarkets near origin w/ distance + retailer slug

### cookidoo
Read:
- `mcp__cookidoo__search_recipes({query, hitsPerPage?})` — Algolia search (empty query rejected; use random_recipe)
- `mcp__cookidoo__random_recipe({category?})` — random recipe (optionally seeded)
- `mcp__cookidoo__get_recipe({id})` — full detail (ingredients, instructions)
- `mcp__cookidoo__get_week_plan({startDate?, span?})` — read existing plan

Write (cookidoo-mcp, ToS-risk override accepted 2026-05-06):
- `mcp__cookidoo__add_to_week({recipeIds, dayKey})` — add 1+ recipes to a day
- `mcp__cookidoo__remove_from_week({recipeId, dayKey})`
- `mcp__cookidoo__clear_week({startDate?, span?})` — wipe plan span (composite, iterates removes)
- `mcp__cookidoo__add_to_shopping_list({recipeIds})` — add ingredients
- `mcp__cookidoo__mark_owned({ingredientIds})` — mark pantry-owned
- `mcp__cookidoo__unmark_owned({ingredientId})`
- `mcp__cookidoo__bookmark_recipe({recipeId})` — Merken
- `mcp__cookidoo__unbookmark_recipe({recipeId})`
- `mcp__cookidoo__rate_recipe({recipeId, rating})` — 1-5 stars

## Auto-checklist (use TaskCreate)

1. Detect mode (interactive vs auto)
2. Read profile.json — abort if missing/invalid
3. Geocode address (if set) + find_stores_nearby
4. Cadence: ask interactively, default from profile in auto
5. Read existing Cookidoo week plan
6. If replace: `clear_week`
7. Fetch weekly offers (using resolved address/zip + preferredStores)
8. Apply diet filter to offers
9. Search Cookidoo for top offer-ingredients (use random_recipe to fill gaps)
10. Fetch recipe details in parallel
11. Apply diet filter to recipes
12. Greedy assembly with overlap optimization
13. `add_to_week` per chosen recipe + dayKey
14. `add_to_shopping_list` for all chosen recipes
15. Build cost-vs-distance shopping plan using find_stores_nearby data
16. Write 4 output files to `~/.weekplan/plans/<YYYY-MM-DD>/`
17. Auto mode: also print plan.md + emit WEEKPLAN_AUTO_DONE line

## Failure modes

- **Profile missing/invalid** → instruct user to copy `profile.example.json` → `~/.weekplan/profile.json` and edit. Exit cleanly.
- **Geocode fails** → fall back to `location.zipCode` if set. Skip nearby-stores step; cost-vs-distance degrades to cost-only. Note in output.
- **Overpass query fails or times out** → skip nearby-stores, cost-only mode, note.
- **Cookidoo cookies expired** → instruct user to re-run playwright-cli login + import-state. Show exact commands.
- **Marktguru offer endpoint TLS or rate-limit** → degrade to generic seasonal basket without offer matching; warn user.
- **Histamine list too restrictive** → if <7 valid recipes survive after 2 search rounds, broaden basket terms and re-search before failing.
- **No vegan dairy alt in offers** → fall back to lactose-free dairy at primary store; surface in notes.
- **`add_to_week` fails for some recipes** → continue pipeline, list failed (recipe, dayKey, error) in Notes section so user can manually add via URL fallback.
- **`clear_week` fails partially** → continue with `add_to_week`; the new writes will simply append. Note it in output.

## After completing

Interactive mode: provide 3 numbered next steps:
1. Open https://cookidoo.de/planning/de-DE to verify plan
2. Open `~/.weekplan/plans/<YYYY-MM-DD>/shopping-list.md` on phone
3. Rate recipes after cooking via `mcp__cookidoo__rate_recipe` so memory tracks preferences

Auto mode: skip next-steps section. Final line of output: `WEEKPLAN_AUTO_DONE <output-file-path>` for scheduler detection.

## Scheduling auto mode

```bash
claude -p "/weekplan --auto" --dangerously-skip-permissions
WEEKPLAN_AUTO=1 claude -p "/weekplan"
```

Cron (Sunday 18:00 local):
```cron
0 18 * * 0 cd /Users/marten/Code/ade_anima/food-planner && /usr/local/bin/claude -p "/weekplan --auto" --dangerously-skip-permissions >> ~/.weekplan/cron.log 2>&1
```

Cookies must be present at `~/.cookidoo-mcp/cookies.txt`. Refresh manually via playwright-cli login + import-state when expired.
