# Cookidoo.de Reverse-Engineered API (read + write (writes added 2026-05-06))

Captured 2026-05-05 via headed Chrome + playwright-cli network inspection. Account: free-tier landing but `subscriptionLevel: "FULL"` in token response.

## Auth

**Cookie session via Vorwerk CIAM SSO** (`eu.login.vorwerk.com`). No Bearer JWT.

Required cookies (after login):

- `_oauth2_proxy` — opaque session token, `domain=.cookidoo.de`
- `v-authenticated` — auth signature, `domain=.cookidoo.de`
- `v-is-authenticated=true`
- `csrf_` + `XSRF-TOKEN` (per-path)
- `tmde-lang=de-DE`

Login flow: `GET https://cookidoo.de/profile/de-DE/login` redirects to `https://eu.login.vorwerk.com/ciam/login?requestId=...`. Form POST email + password. **Cloudflare bot challenge** triggers on stock Chromium fingerprint — must use real Chrome (`--browser=chrome --headed`). Persistent profile recommended (`--persistent`) to keep session.

Import source: `cookidoo-mcp/docs/auth-state.json` (Playwright `state-save` format, gitignored). Runtime auth reads cookies from macOS Keychain only.

## Endpoints

### 1. Search — Algolia (federated)

**Token bootstrap (Cookidoo):**
```
GET https://cookidoo.de/search/api/subscription/token
Cookie: <auth cookies>

→ {
  "apiKey": "<base64 secured-API-key, attribute-restricted>",
  "validUntil": <unix-seconds>,
  "version": "2.0",
  "type": "user",
  "subscriptionLevel": "FULL" | "FREE",
  "additionalFilterValues": {},
  "additionalPhraseKeys": {}
}
```

The returned `apiKey` is a base64-encoded Algolia [Secured API Key](https://www.algolia.com/doc/api-reference/api-methods/generate-secured-api-key/) that already encodes:
- `attributesToRetrieve` (id, title, image, rating, numberOfRatings, totalTime, category, publishedAt, description, url)
- `filters` for role-based access (`allowedRoles:public OR subscription OR ROLE_VORWERKCUSTOMER OR USER`)
- `restrictIndices` (recipes-production-de + variants by sort order, plus collections, editorial, suggestions)
- `validUntil` ttl

Cache token; refresh when `validUntil` is near or 401 seen.

**Query (Algolia):**
```
POST https://3ta8nt85xj-dsn.algolia.net/1/indexes/*/queries
  ?x-algolia-agent=Algolia for JavaScript (5.50.1); Search (5.50.1); Browser
  &x-algolia-api-key=<token.apiKey>
  &x-algolia-application-id=3TA8NT85XJ

Body: {
  "requests": [
    {
      "indexName": "recipes-production-de",
      "params": "query=Lachs&hitsPerPage=20&page=0&facets=[\"category\",\"totalTime\",\"difficulty\"]"
    }
  ]
}
```

App ID: `3TA8NT85XJ`. DSN endpoint host: `3ta8nt85xj-dsn.algolia.net`.

Index naming pattern: `recipes-production-de` (locale suffix); also `-by-publishedAt-desc`, `-by-title-asc`, `-by-rating-desc`, `-by-totalTime-asc`, `-by-preparationTime-asc` for sorts. Also `collections-production-de`, `editorial-production-de`, `category-suggestions-production-de`.

Hit shape (per Algolia retrievable attributes):
```ts
{
  objectID: string,
  id: string,           // e.g. "r807905"
  title: string,
  image: string,        // CDN URL on assets.tmecosys.com
  rating: number,
  numberOfRatings: number,
  totalTime: number,    // minutes
  category: string[],
  publishedAt: number,  // unix
  description: string,
  url: string           // /recipes/recipe/de-DE/r{id}
}
```

### 2. Recipe detail — HTML + JSON-LD

```
GET https://cookidoo.de/recipes/recipe/de-DE/r{id}
Cookie: <auth>

→ HTML page with two <script type="application/ld+json"> blocks:
  - schema.org Recipe (name, image, totalTime PT*M, cookTime, prepTime, recipeYield, recipeCategory[], recipeIngredient[], recipeInstructions[]?, nutrition?)
  - schema.org AggregateRating (ratingValue, reviewCount)
```

**No JSON API for recipe detail.** Parse JSON-LD via cheerio or simple regex:
```ts
const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
```

### 3. Week plan — JSON

```
GET https://cookidoo.de/planning/de-DE/api/my-day/planned-recipes/{YYYY-MM-DD}?span={N}
Cookie: <auth>

→ {
  "dayKeys": [
    { "date": "YYYY-MM-DD", "recipes": [...] },
    ...
  ]
}
```

Empty plan returns `{"dayKeys":[]}`. Dates in ISO `YYYY-MM-DD`. `span` accepts ≥1 (1 day, 7 day week, 30 day month observed).

Write endpoints captured 2026-05-06; user accepted Vorwerk ToS / ban-risk override for experimental project.

### 4. Shopping list — read (content-negotiated) + writes

```
GET https://cookidoo.de/shopping/de-DE
```

Content-negotiated (verified live 2026-06-21):
- `Accept: text/html,...` (browser page nav) → SSR HTML.
- `Accept: application/json` → JSON `{ recipes, customerRecipes, additionalItems }`.
  Each recipe carries `recipeIngredientGroups[]` with `id` (shopping ingredient ULID),
  `isOwned`, `ingredientNotation`, `unitNotation`, `quantity.value`, `shoppingCategory_ref`.

`get_shopping_list` uses the JSON variant. Write mutations use JSON endpoints documented below.

### 5. Read-only enumerations (Phase B) — JSON

All verified live 2026-06-21 on the web+cookie surface. Paths pinned from miaucl/cookidoo-api
(same surface). The **organize** lists (bookmark/custom-list/managed-list) paginate: response
carries `page:{page,totalPages,totalElements}` — fetch every page (page-0-only silently caps
heavy accounts). created-recipes does NOT paginate (see below); profile/subscriptions are single.

```
GET /organize/de-DE/api/bookmark?page={n}           Accept: application/json
GET /organize/de-DE/api/custom-list?page={n}        Accept: application/vnd.vorwerk.organize.custom-list.mobile+json
GET /organize/de-DE/api/managed-list?page={n}       Accept: application/vnd.vorwerk.organize.managed-list.mobile+json
GET /created-recipes/de-DE                          Accept: application/json   (NOT paginated; `?page=` ignored)
GET /community/profile                              Accept: application/json   (NO locale segment)
GET /ownership/subscriptions                        Accept: application/json   (NO locale segment; bare array)
```

- **bookmark**: `{bookmarks[].{id (FAV-…), recipe:{id (r…), asciiTitle, landscapeImage, prepTime (sec-string), locale}}, page}`. The bookmark `id` ≠ recipe `id`; write ops (`bookmark_recipe`/`unbookmark_recipe`) use the recipe id.
- **custom-list / managed-list**: `{customlists|managedlists[].{id, title, listType, author, shared, chapters:[{recipes[]}]}, page}`. custom = user-made (copyable); managed = Vorwerk (follow-only, `author:"Vorwerk"`). `get_collections` merges both, tags by `listType`, surfaces a recipe count summed from the inlined `chapters[].recipes` (the LIST view inlines them — live-verified with the vendor mobile Accept; no dedicated count field).
- **created-recipes**: `{items[].{recipeId (ULID), status, workStatus, modifiedAt, createdAt, recipeContent:{name, image}}, meta:{recipeLimit}}`. The account's own authored recipes. No `page` block — returns the full set in one request; `?page=` is ignored (live-verified), so a single `authedRead` (not `fetchAllPages`).
- **profile**: `{id, isPublic, foodPreferences[], userInfo:{username}, thermomixes[]}`. Empty `username` string → treated as absent.
- **subscriptions**: bare array of `{active, subscriptionLevel, type, status, startDate, expires, subscriptionSource}`. `get_subscription_detail` returns the `active:true` one, else newest by `expires` (don't assume `[0]`). Richer than the coarse search-token level (`get_subscription`).

Own-rating: **no endpoint** — recipe-detail JSON-LD `ratingValue` is the aggregate average, not a per-user rating. No personal-rating surface found; not implemented.

## Write endpoints

All write endpoints require Cookidoo cookie auth plus JSON request headers:

```
Content-Type: application/json
x-requested-with: xmlhttprequest
Referer: https://cookidoo.de/
```

The MCP client retries once on persistent 401/403 auth failures. `204 No Content` returns `{ "ok": true }`; other 2xx responses parse JSON when possible and otherwise return `{ "ok": true }`.

### 1. Add recipes to week plan

```
PUT https://cookidoo.de/planning/de-DE/api/my-day

Body: {
  "_method": "put",
  "recipeSource": "VORWERK",
  "recipeIds": ["r807905"],
  "dayKey": "2026-05-06"
}
```

Return code: `2xx` (`204` handled as no content). Quirks: recipe IDs must be `r`-prefixed; body includes `_method` even though the HTTP method is already `PUT`; `recipeSource` must be `VORWERK`.

### 2. Remove recipe from week plan

```
DELETE https://cookidoo.de/planning/de-DE/api/my-day/{dayKey}/recipes/{recipeId}?recipeSource=VORWERK

Body: {
  "_method": "delete",
  "dayKey": "2026-05-06",
  "recipeId": "r807905",
  "recipeSource": "VORWERK"
}
```

Return code: `2xx` (`204` handled as no content). Quirks: `recipeSource=VORWERK` appears in both the query string and body; recipe IDs must be `r`-prefixed.

### 3. Add recipes to shopping list

```
POST https://cookidoo.de/shopping/de-DE/add-recipes

Body: {
  "recipeIDs": ["r807905"]
}
```

Return code: `2xx` (`204` handled as no content). Quirk: request key is `recipeIDs` with capital `IDs`.

### 4. Mark ingredients as owned

```
POST https://cookidoo.de/shopping/de-DE/owned-ingredients

Body: {
  "ingredientIDS": ["ingredient-id"]
}
```

Return code: `2xx` (`204` handled as no content). Quirk: request key is `ingredientIDS` with all-caps `IDS`.

### 5. Unmark ingredient as owned

```
DELETE https://cookidoo.de/shopping/de/owned-ingredients/{ingredientId}

Body: {
  "_method": "delete"
}
```

Return code: `2xx` (`204` handled as no content). Quirk: locale path is `/shopping/de/`, not `/shopping/de-DE/`.

### 6. Bookmark recipe

```
PUT https://cookidoo.de/organize/de-DE/api/bookmark

Body: {
  "recipeId": "r807905"
}
```

Return code: `2xx` (`204` handled as no content). Quirk: recipe ID must be `r`-prefixed.

### 7. Unbookmark recipe

```
DELETE https://cookidoo.de/organize/de-DE/api/bookmark

Body: {
  "recipeId": "r807905"
}
```

Return code: `2xx` (`204` handled as no content). Quirk: recipe ID must be `r`-prefixed.

### 8. Rate recipe

```
PUT https://cookidoo.de/rating/de-DE/user-ratings/recipes/{recipeId}

Body: {
  "_method": "put",
  "rating": "5"
}
```

Return code: `2xx` (`204` handled as no content). Quirks: recipe ID must be `r`-prefixed in the URL; `rating` must be a string, not a number.

### Composite: clear week

`clear_week(startDate?, span?)` is not a standalone Cookidoo endpoint. It reads `GET /planning/de-DE/api/my-day/planned-recipes/{date}?span={n}`, then calls the remove-from-week endpoint for every recipe returned under `dayKeys[].recipes[]`, accepting either `id` or `recipeId` fields. It continues after per-recipe failures and returns `{ removed, errors }`.

## Implementation notes for cookidoo-mcp (Bun/TS)

1. **Auth source**: import the Playwright storage state once, extract only Cookidoo cookies, and store the `Cookie:` header at `~/.cookidoo-mcp/cookies.txt` (mode 0600). Startup reads that file only. Reissue login via headed Playwright if cookies expired. Plain-file storage chosen over macOS Keychain because Keychain ACL prompts blocked non-interactive use.

2. **Token refresh**: hit `/search/api/subscription/token` lazily on every search if `validUntil <= Date.now()/1000 + 60`.

3. **Algolia client**: use the official `algoliasearch` npm package or hand-rolled `fetch` (URL-encoded headers). Prefer hand-rolled to avoid heavy SDK and to keep the secured-key pattern explicit.

4. **MCP tools (read + write)**:
   - `search_recipes(query, hitsPerPage?)` → calls token endpoint then Algolia query
   - `get_recipe(id)` → fetches HTML, parses JSON-LD blocks
   - `get_week_plan(startDate?, span?)` → calls planning API; default startDate = today, span = 7
   - `add_to_week(recipeIds, dayKey)` → adds recipes to a day in Meine Woche
   - `remove_from_week(recipeId, dayKey)` → removes one recipe from a day in Meine Woche
   - `clear_week(startDate?, span?)` → removes every planned recipe in a date span
   - `add_to_shopping_list(recipeIds)` → adds recipe ingredients to the shopping list
   - `mark_owned(ingredientIds)` → marks shopping ingredients as owned
   - `unmark_owned(ingredientId)` → removes one owned-ingredient marker
   - `bookmark_recipe(recipeId)` → adds a recipe bookmark
   - `unbookmark_recipe(recipeId)` → removes a recipe bookmark
   - `rate_recipe(recipeId, rating)` → writes a 1-5 user rating

5. **Cloudflare**: not needed for the captured endpoints — only the login flow triggers CF challenge. As long as the cookie session stays valid, direct `fetch` from Bun works.

6. **HTML parser**: use Bun's native `HTMLRewriter` or `cheerio`. JSON-LD extraction is a single regex; parser overkill.
