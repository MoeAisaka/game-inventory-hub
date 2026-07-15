# Game Inventory Hub

A self-hosted dashboard for a personal game library and physical/digital inventory. It combines play status, play sessions, release dates, external metadata, import workflows, inventory movements, and audit history.

## Features

- Game catalog with multilingual names, platform, release date, cover, ratings, and play-time estimates
- Manual-first metadata precedence with optional Steam and IGDB synchronization
- Play sessions and conservative status inference
- Numbered backlog ordering for easy insertion and reprioritization
- Inventory items and append-only stock movements
- Preview, commit, rollback, and audit trails for spreadsheet imports
- Isolated read-only PlayStation and Nintendo Sidecars that emit normalized snapshots
- Staged platform snapshot ingestion with idempotency keys and manual-first matching
- Hash-verified four-source catalog rebuild plans for Steam, PlayStation, Nintendo, and IGDB
- Purchase-link normalization and safe cover-image host policies
- Single-owner authentication with Argon2id password hashes and server-side sessions

## Security defaults

- Same-origin checks protect cookie-authenticated mutations.
- Session cookies are HTTP-only, SameSite=Lax, and secure by default.
- Login failures are rate-limited.
- Internal sync requires a separate high-entropy bearer secret.
- External API responses are schema-validated and requests have bounded timeouts.
- Security headers are configured in `next.config.ts`.

## Requirements

- Node.js 20+
- PostgreSQL 15+

## Local setup

```bash
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev
```

Optional Sidecars have independent dependencies and private state directories:

```bash
npm --prefix integrations/playstation-sidecar ci
npm --prefix integrations/nintendo-sidecar ci
npm run psn:test
npm run nintendo:test
```

The catalog rebuild is deliberately fail-closed. Generate and inspect a plan first, create a database backup, and calculate its SHA-256 digest. The apply command requires the backup file itself, its expected digest, and the confirmed plan digest; it verifies both files before opening a database connection. Set `ALLOW_CATALOG_REBUILD=true` only for the reviewed execution. Never use the example snapshots as production data.

```bash
ALLOW_CATALOG_REBUILD=true npm run catalog:apply -- \
  --plan /private/path/catalog-plan.json \
  --confirm-plan-sha256 <reviewed-plan-sha256> \
  --backup /private/path/pre-rebuild.dump \
  --backup-sha256 <verified-backup-sha256> \
  --result /private/path/rebuild-result.json
```

Create the first user with your own administration workflow before exposing the service. The community repository intentionally ships no production database, user account, imported game data, API key, or deployment hostname.

## Verification

```bash
npm run verify
```

Run behind an HTTPS reverse proxy. Keep PostgreSQL private, set `SESSION_COOKIE_SECURE=true`, and store all credentials outside Git.

## Status

Community edition `0.13.1`. Connectors are optional and disabled when credentials are absent. The repository contains no production database, account identifier, imported library, API credential, deployment hostname, or private Sidecar state.
