#!/usr/bin/env bash
set -euo pipefail

# Launch the cookidoo MCP server from the pinned git dependency.
# .mcp.json's `cwd` field is ignored by Claude Code (#17565), so we cd here.
cd "${CLAUDE_PLUGIN_ROOT}"

# Install on first run or when the lockfile changed (deps fetched from GitHub via git+ssh).
if [[ ! -d node_modules/cookidoo-mcp || bun.lock -nt node_modules ]]; then
  bun install --frozen-lockfile --silent 1>/dev/null
fi

exec bun run node_modules/cookidoo-mcp/src/index.ts
