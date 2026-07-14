#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
python3 scripts/secret_scan.py --tracked
npm run lint
npm run typecheck
DATABASE_URL='postgresql://app@127.0.0.1:1/unused' APP_ORIGIN='http://127.0.0.1:3000' SESSION_COOKIE_SECURE=false \
  npx vitest run src/server/migration/openxml.test.ts src/server/services/dashboard.test.ts src/server/http/auth.test.ts
if command -v gitleaks >/dev/null 2>&1; then
  if [ "${PREFLIGHT_MODE:-commit}" = commit ]; then gitleaks git --staged --redact --no-banner .; else gitleaks git --redact --no-banner .; fi
fi
