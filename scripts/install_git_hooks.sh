#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Initialize Git before installing hooks." >&2
  exit 2
fi

HOOK_DIR=$(git -C "$ROOT" rev-parse --git-path hooks)
mkdir -p "$HOOK_DIR"
printf '%s\n' '#!/bin/sh' 'PREFLIGHT_MODE=commit exec "$(git rev-parse --show-toplevel)/scripts/preflight.sh"' > "$HOOK_DIR/pre-commit"
printf '%s\n' '#!/bin/sh' 'PREFLIGHT_MODE=push exec "$(git rev-parse --show-toplevel)/scripts/preflight.sh"' > "$HOOK_DIR/pre-push"
chmod 0755 "$HOOK_DIR/pre-commit" "$HOOK_DIR/pre-push"
echo "Installed fail-closed pre-commit and pre-push hooks."
