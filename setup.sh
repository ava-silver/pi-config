#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_dir="${PI_CODING_AGENT_DIR:-${XDG_CONFIG_HOME:+${XDG_CONFIG_HOME}/pi}}"
config_dir="${config_dir:-$HOME/.pi}"
mkdir -p "$config_dir"
ln -sfn "$repo_dir/web-search.json" "$config_dir/web-search.json"

if command -v bun >/dev/null 2>&1; then
  (cd "$repo_dir/extensions" && bun install --frozen-lockfile)
else
  echo "Warning: bun not found; Pi extension dependencies were not installed" >&2
fi
