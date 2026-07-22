#!/bin/sh
set -eu

steam_id="${STEAM_ID:-}"
if [ -z "$steam_id" ]; then
  echo "请先设置 STEAM_ID" >&2
  exit 1
fi

export STEAM_FAMILY_ACCESS_TOKEN="$(security find-generic-password -s game-inventory-steam-family-token -w)"
export SYNC_CRON_SECRET="$(security find-generic-password -s game-inventory-sync-cron-secret -w)"
export GAME_INVENTORY_API_BASE_URL="${GAME_INVENTORY_API_BASE_URL:-https://games.example.invalid}"

exec node "$(dirname "$0")/steam-family-sync.mjs" "$@"
