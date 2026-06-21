# cookidoo-mcp (Bun/TS, read + write)

MCP server for the Cookidoo.de recipe portal. Read + write support is experimental: write endpoints were captured 2026-05-06, and the user accepted the Vorwerk ToS / account-ban risk override for this local project.

## Tools

- `search_recipes(query, hitsPerPage?)` — Algolia-backed recipe search. Returns title, image, rating, totalTime, category, URL.
- `get_recipe(id)` — fetches recipe detail (ingredients, instructions, times, yield) by parsing schema.org JSON-LD from the recipe page.
- `get_week_plan(startDate?, span?)` — reads the current Cookidoo "Meine Woche" plan via `GET /planning/de-DE/api/my-day/planned-recipes/{date}?span={n}`.
- `get_shopping_list()` — reads the current shopping list via `GET /shopping/de-DE` with `Accept: application/json`. Returns recipe count, a flat ingredient list (each with shopping ingredient ID, owned state, quantity, unit, category, source recipe), and freeform additional items. The ingredient IDs feed `mark_owned` / `unmark_owned`.
- `get_subscription()` — returns the account's coarse subscription level (`FULL` / `FREE` / `NONE`), derived from the search token. No extra request.
- `get_subscription_detail()` — current subscription with level, type, status, start date, expiry via `GET /ownership/subscriptions`. Richer/authoritative vs `get_subscription`; one request. `null` if no record.
- `get_bookmarks()` — lists bookmarked recipes via `GET /organize/de-DE/api/bookmark` (paginated). Each entry: recipe ID, title, image, prep time, locale.
- `get_collections()` — lists recipe collections via `GET /organize/de-DE/api/custom-list` + `.../managed-list` (vendor Accept, paginated). Merged, tagged `CUSTOMLIST` (user-made) / `MANAGEDLIST` (Vorwerk, follow-only); id, title, author, shared, recipe count.
- `get_custom_recipes()` — lists the account's own authored recipes via `GET /created-recipes/de-DE` (single request — endpoint returns the full set, not paginated). id (ULID), name, status, work status, timestamps, image.
- `get_profile()` — reads the community profile via `GET /community/profile` (no locale segment). id, username, public flag, food preferences, Thermomix count.
- `add_to_week(recipeIds, dayKey)` — adds one or more recipes to a Cookidoo week-plan day.
- `remove_from_week(recipeId, dayKey)` — removes one recipe from a Cookidoo week-plan day.
- `clear_week(startDate?, span?)` — removes every recipe in a week-plan date span and reports per-recipe errors.
- `add_to_shopping_list(recipeIds)` — adds recipe ingredients to the Cookidoo shopping list.
- `mark_owned(ingredientIds)` — marks shopping-list ingredients as owned.
- `unmark_owned(ingredientId)` — removes the owned marker from one shopping-list ingredient.
- `bookmark_recipe(recipeId)` — bookmarks a Cookidoo recipe.
- `unbookmark_recipe(recipeId)` — removes a Cookidoo recipe bookmark.
- `rate_recipe(recipeId, rating)` — writes a 1-5 user rating for a Cookidoo recipe.

## Auth

Cookie session via Vorwerk CIAM SSO (`eu.login.vorwerk.com`). Cookidoo cookies are extracted from a user-provided Playwright storage state and stored at `~/.cookidoo-mcp/cookies.txt` with mode `0600` (owner read/write only). Plain file storage is intentional for this single-user hobby project: macOS Keychain ACL prompts and Bun.secrets identity-isolation behavior were both blockers; file permission is the simplest workable scheme. Anything able to read your home as your user can read this file — same threat model as a `~/.ssh/id_*` private key.

### Initial setup

1. Use playwright-cli with `--browser=chrome --headed --persistent` and log in to cookidoo.de manually (Cloudflare bot challenge blocks plain Chromium).
2. Save the storage state: `playwright-cli -s=<session> state-save /path/to/auth-state.json`.
3. Import: `bun run src/import-state.ts /path/to/auth-state.json` — extracts cookies, writes `~/.cookidoo-mcp/cookies.txt`, deletes source state file.

After a successful import, the importer deletes the supplied Playwright storage state because it contains live cookies. Pass `--keep-state` to retain it:

```bash
bun run src/import-state.ts --keep-state /path/to/auth-state.json
bun run src/import-state.ts /path/to/auth-state.json --keep-state
```

When `--keep-state` is used, the importer prints a stderr warning with the retained path.

Manual inspection:

```bash
cat ~/.cookidoo-mcp/cookies.txt
```

### Re-auth

When cookies expire (typically weeks/months), re-run steps 1-3.

## Known limitations

- Cookies live as a plaintext 0600 file, not in Keychain. Acceptable for this single-user local project; equivalent to SSH keys in trust model.

## API spec

See `docs/api.md` for full reverse-engineered endpoint documentation captured 2026-05-05.

## Configuration

- `COOKIDOO_LOCALE` — full path locale, default `de-DE`. Sets the domain (`cookidoo.de` → `.co.uk`, `.fr`, …), URL path locale, Algolia index lang, and `Accept-Language`. Unknown locales fall back to `cookidoo.<country>`. Only the request paths are localized: cookie-import validation still expects `cookidoo.de` cookies and `random_recipe` seeds are German, so non-DE is not yet usable end-to-end.
- `COOKIDOO_ALGOLIA_INDEX` — override the search index name (default `recipes-production-<lang>`). Non-DE index names are inferred and unverified; set this if search returns nothing.

## Run

```bash
bun install
bun run src/index.ts        # stdio MCP server
bunx tsc --noEmit            # typecheck
```

First run installs deps automatically. To pre-install: `cd cookidoo-mcp && bun install`.

## .mcp.json

Claude Code expands environment variables in project `.mcp.json` values, including `args`. This repo uses `THERMOXMIX_ROOT` with `/Users/marten/Code/thermoxMix` as the post-merge default.

### Pre-merge worktree testing

Before this branch is merged, the default path may not exist in the main checkout. Start Claude Code with `THERMOXMIX_ROOT` pointing at this worktree:

```bash
THERMOXMIX_ROOT=/Users/marten/Code/thermoxMix/.claude/worktrees/weekplan-pipeline claude
```

Then the configured server path resolves to `cookidoo-mcp/src/index.ts` inside the worktree. After merge, no override is needed.

```json
{
  "mcpServers": {
    "cookidoo": {
      "type": "stdio",
      "command": "${THERMOXMIX_ROOT:-/Users/marten/Code/thermoxMix}/cookidoo-mcp/bin/serve.sh",
      "args": []
    }
  }
}
```
