#!/usr/bin/env bash
set -euo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pkg_dir"

if [[ ! -f bun.lock ]]; then
  echo "Missing bun.lock in $pkg_dir; cannot start supermarkets-mcp." >&2
  exit 1
fi

if [[ ! -d node_modules || bun.lock -nt node_modules ]]; then
  bun install --frozen-lockfile --silent 1>/dev/null
fi

# Source WEEKPLAN_CONTACT from profile if not already set in env.
# Nominatim/Overpass usage policies require operator contact info in User-Agent.
profile="${HOME}/.weekplan/profile.json"
if [[ -z "${WEEKPLAN_CONTACT:-}" && -f "$profile" ]]; then
  contact="$(bun -e 'const p=require(process.argv[1]);process.stdout.write(p?.location?.nominatimContact??"")' "$profile" 2>/dev/null || true)"
  if [[ -n "$contact" ]]; then
    export WEEKPLAN_CONTACT="$contact"
  fi
fi

exec bun run src/index.ts
