# Game Inventory Hub

A self-hosted dashboard for a personal game library and physical/digital inventory. It combines play status, play sessions, release dates, external metadata, import workflows, inventory movements, and audit history.

## Features

- Game catalog with multilingual names, platform, release date, cover, ratings, and play-time estimates
- Manual-first metadata precedence with optional Steam and IGDB synchronization
- Play sessions and conservative status inference
- Numbered backlog ordering for easy insertion and reprioritization
- Inventory items and append-only stock movements
- Preview, commit, rollback, and audit trails for spreadsheet imports
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

Create the first user with your own administration workflow before exposing the service. The community repository intentionally ships no production database, user account, imported game data, API key, or deployment hostname.

## Verification

```bash
npm run verify
```

Run behind an HTTPS reverse proxy. Keep PostgreSQL private, set `SESSION_COOKIE_SECURE=true`, and store all credentials outside Git.

## Status

Community-edition candidate. Connectors are optional and disabled when credentials are absent.
