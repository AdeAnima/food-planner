# food-planner

Claude Code plugin for weekly meal planning. Bundles two MCP servers and a `/weekplan` skill that orchestrates the full pipeline: Marktguru offer scrape → recipe selection on Cookidoo → meal plan + shopping list write-back.

## Components

```
food-planner/
├── .claude-plugin/plugin.json     # Plugin manifest
├── .mcp.json                       # MCP server definitions (uses ${CLAUDE_PLUGIN_ROOT})
├── mcp-servers/
│   ├── cookidoo/                   # Vorwerk Cookidoo automation (read + write tools)
│   └── supermarkets-mcp/         # Marktguru weekly-offer search
├── skills/weekplan/                # /weekplan orchestrator skill
└── .claude/skills/weekplan         # symlink → skills/weekplan (project-scope discovery)
```

## Use

**As project (today, no marketplace needed):**
```bash
cd ~/Code/ade_anima/food-planner
claude
# /weekplan triggers the skill; cookidoo + supermarkets-mcp MCPs auto-load
```

**As installable plugin (future):**
1. Register a local marketplace pointing at this repo
2. `/plugin install food-planner@<marketplace>`
3. Both MCPs and skill become available everywhere

## MCP servers

| Server | Source | Tools |
|--------|--------|-------|
| `cookidoo` | [`cookidoo-mcp`](https://github.com/AdeAnima/cookidoo-mcp) git dep (`bin/cookidoo-serve.sh`) | recipes, week-plan, shopping list, bookmarks, ratings |
| `supermarkets-mcp` | `mcp-servers/supermarkets-mcp/` | Marktguru weekly offers across DE retailers |

`cookidoo` is consumed as a pinned git dependency (no vendored copy): `package.json` pins `cookidoo-mcp` (which pins `cookidoo-core`), and `bin/cookidoo-serve.sh` launches it from `node_modules`. `supermarkets-mcp` ships a local `bin/serve.sh` that auto-installs Bun deps on first run.

## Skill

`/weekplan` reads `~/.weekplan/profile.json` (diet, household, address, store filters), geocodes the address to find nearby supermarkets via OSM, pulls current Marktguru offers, picks recipes from Cookidoo, balances offer-savings vs travel-distance, and writes the meal plan + shopping list back to Cookidoo. Outputs a full weekly artifact set under `~/.weekplan/plans/<YYYY-MM-DD>/` (plan.md, shopping-list.md, offers.json, recipes.json). Supports `--auto` for unattended cron runs.

### Profile

Copy `skills/weekplan/profile.example.json` to `~/.weekplan/profile.json` and edit. Schema: `skills/weekplan/profile.schema.json`.

## Cookies

`cookidoo-mcp` requires a logged-in browser session at `~/.cookidoo-mcp/cookies.txt`. Refresh via the `playwright-cli` skill (`login` + `import-state`) when expired.

## History

This repo started as `~/Code/thermoxMix/` — a monorepo for Cookidoo + Marktguru experiments. It was restructured into a Claude Code plugin layout and moved to `~/Code/ade_anima/food-planner/` on 2026-05-10.
