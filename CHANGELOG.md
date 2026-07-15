# Changelog

## Unreleased

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
