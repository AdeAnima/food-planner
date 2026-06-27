# food-planner

A Claude Code plugin for weekly meal planning. It bundles two MCP servers and a `/weekplan` skill that runs the full pipeline: scrape current German supermarket offers → pick recipes on Cookidoo → write a 7-day meal plan and a per-store shopping list back to Cookidoo.

> **Unofficial & experimental.** This project is not affiliated with, endorsed by, or sponsored by Vorwerk. It talks to Cookidoo through a reverse-engineered, undocumented API using your own account. See the [Disclaimer](#disclaimer) before using it.

## Install

```
/plugin marketplace add AdeAnima/adeanima-plugins
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

## Disclaimer

This is an **unofficial**, community-built, experimental project intended for personal and educational use / trial only. It is **not affiliated with, endorsed by, or sponsored by Vorwerk**.

It communicates with Cookidoo through a **reverse-engineered, undocumented web API** using **your own account credentials**. That API may change or break without notice. Automating a logged-in service may be inconsistent with Cookidoo's Terms of Service — **you are solely responsible** for ensuring your use complies with those Terms. Use at your own risk; the authors accept no liability for any consequences to your account or data.

The software is provided "AS IS", without warranty of any kind, as set out in the [MIT License](LICENSE).

**Trademarks.** Thermomix® and Cookidoo® are registered trademarks of Vorwerk International AG (Wollerau, Switzerland); Vorwerk® is a registered trademark of Vorwerk SE & Co. KG (Wuppertal, Germany). These names are used here purely descriptively (§23 MarkenG / Art. 14 EU Trade Mark Directive), solely to identify the service this tool interoperates with. No affiliation or endorsement is implied. All trademarks belong to their respective owners.

## License

MIT © Martin Westphal
