#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.config/mcp"
ln -sfn "$repo_dir/mcp.json" "$HOME/.config/mcp/mcp.json"

if command -v bun >/dev/null 2>&1; then
  (cd "$repo_dir/extensions" && bun install --frozen-lockfile)
else
  echo "Warning: bun not found; Pi extension dependencies were not installed" >&2
fi
