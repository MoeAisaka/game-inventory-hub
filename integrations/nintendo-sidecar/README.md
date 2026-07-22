# Nintendo read-only Sidecar

This isolated one-shot adapter uses the community-maintained `nxapi` CLI. The default path reads Nintendo Account / NSO play activity (game list, total play time, first played time). Parental Controls remains an optional enhancement for daily/monthly detail.

## Safety boundary

- Preview-only. There is no submit command and no main database write path.
- Default mode is NSO play activity (`nso play-activity`). Parental Controls is optional with `NINTENDO_SYNC_MODE=pctl`.
- `nxapi` remains a separate AGPL-3.0-or-later process and dependency; its code is not copied into the main application.
- Nintendo session state and raw usage summaries live only under `.runtime/nintendo` with private permissions.
- `NXAPI_DEBUG_FILE=0` is always enforced because nxapi debug logs may contain sensitive tokens.
- NSO mode is scoped to the authenticated Nintendo Account. PCTL mode still requires an explicit player on multi-user consoles.
- Played titles do not prove ownership, so normalized items keep `isOwned=false`.

## First authorization

Start a durable two-step authorization from the application root:

```sh
npm run nintendo:auth
```

Follow the printed Nintendo login URL. On the account selection page, copy the complete link that starts with `npf71b963c1b7b6d119://auth`; do not copy the browser address bar's `authorize` URL. Save the callback privately, then complete the same pending PKCE authorization within 30 minutes:

```sh
security find-generic-password -a nintendo -s games.example.invalid.nintendo-auth-callback -w \
  | npm run nintendo:auth:complete
```

也可以直接运行交互式入口（推荐），终端会隐藏读取回调并在交换一次性授权码前校验格式：

```sh
npm run nintendo:auth:complete
```

不要使用 `read -s "CALLBACK?提示" CALLBACK`：在 zsh 中重复变量名会把已读取的回调覆盖为空值。

The pending verifier is written with mode `0600`, which makes the authorization resumable across chat turns without exposing it. Never paste the callback URL or resulting token into chat.

Generate the first NSO preview:

```sh
npm run nintendo:preview
```

For optional Parental Controls detail, run:

```sh
NINTENDO_SYNC_MODE=pctl NINTENDO_PLAYER_ID='player-id' npm run nintendo:preview
```

The private preview is written to `output/nintendo/preview-latest.json`.

## Known platform limits

- Nintendo does not expose a stable public personal-library API for this use case.
- NSO play activity yields played titles, not a complete ownership library.
- NSO does not return a reliable last-played timestamp; the Sidecar derives it only when total time increases between periodic snapshots.
- The authenticated user's NSO presence endpoint is no longer supported by nxapi, so this Sidecar does not claim live self-presence.
- Platform generation (Switch vs Switch 2) is not reliably present in Parental Controls summaries; the normalized platform is `NINTENDO_SWITCH_FAMILY` until a trustworthy source is available.
