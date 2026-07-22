# PlayStation read-only Sidecar

This isolated one-shot process reads the authenticated account's played games, PS4/PS5 purchase library and trophy summaries through the community-maintained `psn-api` package. It never performs a PlayStation write action.

## Safety boundary

- Default mode is preview-only; it writes a private JSON file and does not call the main application.
- NPSSO is accepted only from an environment secret or secret file for initial token exchange.
- Access and refresh tokens are stored only in the Sidecar state file with mode `0600`.
- Preview output and token state are excluded from source archives.
- Raw tokens, NPSSO values, cookies and raw dependency responses are never logged.
- Purchase library or trophy failures produce a partial preview; the required played-games source still has to succeed.
- `--submit` is separate and requires the main system's internal Bearer secret. Submission writes only to `platform_library_items` staging.

## First authorization on macOS

1. Sign in at https://www.playstation.com/ in a private browser window.
2. In the same browser open https://ca.account.sony.com/api/v1/ssocookie.
3. Copy only the `npsso` value. Treat it like a password.
4. Store it in Keychain, not in chat:

```zsh
read -s "NPSSO?PlayStation NPSSO: "
echo
security add-generic-password -U \
  -a playstation \
  -s games.example.invalid.playstation-npsso \
  -w "$NPSSO"
unset NPSSO
```

5. From the application root run `npm run psn:preview`.

After the first successful exchange, the runner removes its temporary NPSSO file. Later previews use the refresh token from `.runtime/playstation/auth.json`. If Sony invalidates it, acquire a new NPSSO and update Keychain.

## Preview output

The latest private preview is written to `output/playstation/preview-latest.json`. It contains only normalized account and game metadata, a source health summary, a content hash and an idempotency key.

Do not submit until the preview counts and sample records are reviewed. Submission is intentionally not exposed through the default root script.
