#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! docker compose ps --status running blastr >/dev/null 2>&1; then
  echo "xannyblastr container is not running."
  echo "Start it with:"
  echo "  docker compose up -d"
  exit 1
fi

exec docker compose exec blastr node src/cli.js "$@"