# Changelog

## Unreleased

## 0.34.0 - 2026-07-22

- Add a unified action home, play planner, wishlist, release catalog, media library, and analytics surfaces.
- Add inventory v2 products, variants, append-only movements, reversal workflows, and compatibility views for legacy inventory.
- Separate activity state from completion facts and add lifecycle-safe quick actions.
- Add multilingual search normalization, platform-aware matching, game ratings, hardware capability profiles, and purchase advice.
- Add Steam Family, screenshot, wishlist, release, and public-store integrations with isolated state and bounded network behavior.
- Add database migrations 0011 through 0034 and regression coverage for the new state, search, inventory, release, and media contracts.
- Exclude production databases, account identifiers, imported libraries, deployment scripts, browser artifacts, hostnames, and private Sidecar state from this community release.

## 0.14.0 - 2026-07-15

- Add page-level selection and filtered-result selection for game records.
- Add atomic bulk status, platform, queue-order, and soft-delete operations.
- Reject stale filtered selections with an `expectedTotal` conflict check.
- Limit each bulk operation to 1,000 games and queue positions to the supported range.
- Record one aggregate audit event per bulk request instead of one event per game.
- Add regression coverage for explicit selection, filtered selection, rollback, soft delete, and audit metadata.
- Keep production records, hostnames, backup paths, deployment scripts, and browser artifacts out of the community release.

## 0.13.1 - 2026-07-15

- Add isolated PlayStation and Nintendo read-only Sidecars.
- Add idempotent staged platform snapshot ingestion.
- Add a generalized, hash-verified four-source catalog rebuild workflow.
- Verify the referenced backup file against its SHA-256 digest before catalog mutation.
- Add database migration `0010` for platform staging and rebuild support.
- Add purchase-link normalization and cover-image host validation.
- Remove production counts, game identifiers, hostnames, credentials, and deployment paths from the community implementation.

- Override development-only `esbuild` copies to patched version 0.28.1.
- Initial community-edition candidate with production data removed.
- Regenerated the dependency lock with npm 10 so clean installs are portable across Node.js 20 and 22 CI runners.
