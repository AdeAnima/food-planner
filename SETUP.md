# food-planner — first-run setup

Two things must exist before `/weekplan` works: a **diet profile** and a **Cookidoo login**.

## 1. Diet profile

```bash
# PLUGIN points at the installed plugin (adjust the marketplace name if you renamed it):
PLUGIN=~/.claude/plugins/cache/adeanima/food-planner

mkdir -p ~/.weekplan
cp "$PLUGIN/skills/weekplan/profile.example.json" ~/.weekplan/profile.json
$EDITOR ~/.weekplan/profile.json
```

Edit diet, household, address, and store filters. `location.nominatimContact` (your email or a URL) is **required** — it goes in the User-Agent for OSM geocoding, which refuses requests without it. Schema: `skills/weekplan/profile.schema.json`.

## 2. Cookidoo login (one-time, manual)

The Cookidoo MCP reads a logged-in cookie jar at `~/.cookidoo-mcp/cookies.txt`. Cloudflare blocks automated login, so a **human must log in once in a real browser**, then the session is exported into the jar.

Using the [`playwright-cli`](https://github.com/microsoft/playwright) skill (or any browser that can export Playwright storage state):

1. Open a headed browser to `https://cookidoo.de/profile/de-DE` (redirects to the Vorwerk login form).
2. Log in by hand and clear the Cloudflare check. You're in once the `_oauth2_proxy` cookie is set.
3. Export the browser storage state to a JSON file, e.g. `state.json`.
4. Import it into the jar:

   ```bash
   bun "$PLUGIN/mcp-servers/cookidoo/src/core/import-state.ts" state.json
   ```

   This writes `~/.cookidoo-mcp/cookies.txt` (mode 0600) and deletes the state file.

The jar expires periodically — when `/weekplan` reports expired cookies, repeat step 2–4.

> Requires an active Cookidoo (Vorwerk Thermomix) subscription. The plugin does not create accounts.
