# Steam Family Sidecar

本地只读同步 Steam Families 共享库。网页 access token 只保存在 macOS 钥匙串，不上传 NAS；NAS 只接收标准化后的 AppID、标题、所有者、可用状态和游玩摘要。

## 安全边界

- 使用 Steam 网页已登录会话取得的短期 access token；不保存账号密码和 Cookie。
- token 过期时明确失败，自购游戏库仍由官方 `GetOwnedGames` 正常同步。
- 家庭共享记录标记为 `FAMILY_SHARED`，不会记为已购买；退出家庭或被排除后保留历史并标记不可访问。
- `IFamilyGroupsService` 未写入 Steamworks 正式公开契约，字段可能变化，因此解析失败时停止写入。

## 使用

将 Steam 网页 access token 和系统内部同步密钥写入钥匙串：

```sh
security add-generic-password -U -a "$USER" -s game-inventory-steam-family-token -w '<access-token>'
security add-generic-password -U -a "$USER" -s game-inventory-sync-cron-secret -w '<sync-secret>'
```

先预览，再同步：

```sh
STEAM_ID=7656119xxxxxxxxxx ./run-macos-keychain.sh --preview
STEAM_ID=7656119xxxxxxxxxx ./run-macos-keychain.sh
```

脚本日志不会打印 token、Cookie 或内部同步密钥。
