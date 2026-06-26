#!/usr/bin/env bash
set -euo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pkg_dir"

if [[ ! -f bun.lock ]]; then
  echo "Missing bun.lock in $pkg_dir; cannot start cookidoo-mcp." >&2
  exit 1
fi

if [[ ! -d node_modules || bun.lock -nt node_modules ]]; then
  bun install --frozen-lockfile --silent 1>/dev/null
fi

exec bun run src/index.ts
