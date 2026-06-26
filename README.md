# food-planner

A Claude Code plugin for weekly meal planning. It bundles two MCP servers and a `/weekplan` skill that runs the full pipeline: scrape current German supermarket offers → pick recipes on Cookidoo → write a 7-day meal plan and a per-store shopping list back to Cookidoo.

## Install

```
/plugin marketplace add AdeAnima/claude-marketplace
/plugin install food-planner@adeanima
```

Then complete the one-time setup (diet profile + Cookidoo login) — see **[SETUP.md](SETUP.md)**. After that, run `/weekplan` from any project.

> The plugin loads its MCP servers only when installed as a plugin (the server paths resolve via `${CLAUDE_PLUGIN_ROOT}`). Opening this repo as a plain project will not start the MCP servers.

## Requirements

- [Bun](https://bun.sh) on `PATH` — both MCP servers run on it and self-install their dependencies on first launch.
- An active **Cookidoo** (Vorwerk Thermomix) subscription — required for recipe and meal-plan access. The plugin does not create accounts.

## Layout

```
food-planner/
├── .claude-plugin/plugin.json      # Plugin manifest
├── .mcp.json                       # MCP server definitions (uses ${CLAUDE_PLUGIN_ROOT})
├── mcp-servers/
│   ├── cookidoo/                   # Cookidoo automation server (self-contained, vendored)
│   │   ├── src/index.ts            #   MCP entrypoint
│   │   └── src/core/               #   vendored cookidoo access library
│   └── supermarkets-mcp/           # Marktguru weekly-offer search
├── skills/weekplan/                # /weekplan orchestrator skill
└── SETUP.md                        # First-run setup (profile + login)
```

## MCP servers

| Server | What it does |
|--------|--------------|
| `cookidoo` | Cookidoo recipes, week plan, shopping list, bookmarks, ratings (read + write). |
| `supermarkets-mcp` | Marktguru weekly offers across German retailers. |

Both servers are self-contained: each ships its source plus a `bin/serve.sh` that runs `bun install --frozen-lockfile` on first launch (public dependencies only — `@modelcontextprotocol/sdk`, `zod`) and then starts the server. There are no private dependencies and no build step.

The Cookidoo server vendors its access library under `mcp-servers/cookidoo/src/core/` rather than pulling it as an external dependency, so the plugin installs cleanly for anyone with no extra access.

## The `/weekplan` skill

`/weekplan` reads `~/.weekplan/profile.json` (diet, household, address, store filters), geocodes the address to find nearby supermarkets via OpenStreetMap, pulls current Marktguru offers, picks recipes from Cookidoo, balances offer savings against travel distance, and writes the meal plan plus shopping list back to Cookidoo's "Meine Woche". Every run is persisted under `~/.weekplan/plans/<YYYY-MM-DD>/` (`plan.md`, `shopping-list.md`, `offers.json`, `recipes.json`).

`--auto` runs it unattended (e.g. from a scheduled task) using profile defaults and no prompts.

See **[SETUP.md](SETUP.md)** for the profile schema and the one-time Cookidoo login.

## License

MIT © Martin Westphal
