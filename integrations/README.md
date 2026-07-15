# PlayStation / Nintendo 只读适配边界

主系统不保存平台密码、Cookie、NPSSO 或 Nintendo 登录令牌，也不直接依赖逆向客户端。

平台适配器必须作为隔离 Sidecar 运行：

1. Sidecar 在独立 Secret 存储中保管平台凭证。
2. Sidecar 只读取游戏库、时长、最近游玩和进度，并转换为 `examples/` 中的标准快照。
3. Sidecar 使用生产 `SYNC_CRON_SECRET` 调用 `POST /api/v1/internal/platform-snapshot`，同时传入唯一 `Idempotency-Key`。
4. 主系统只写入 `platform_library_items` 暂存层；精确外部映射或唯一规范名称才标记为已匹配。
5. 平台快照不会直接修改正式游戏、人工状态、人工进度或购买记录。

PlayStation 评估基线为 MIT 许可的 `achievements-app/psn-api`。NPSSO 等同密码，只允许进入 Sidecar Secret，不得进入主系统或日志。

Nintendo 评估基线为 AGPL-3.0 的 `samuelthomas2774/nxapi`。其代码不得复制进主仓库，必须保持独立进程及许可证边界；Nintendo 接口变化时只停用 Sidecar，不影响主服务。

Nintendo 第一阶段选择 `pctl` 家长控制使用记录，不使用已经无法稳定读取本人在线状态的 NSO presence。当前 `integrations/nintendo-sidecar` 仅生成私有预览，不提供提交命令；多用户主机必须明确选择玩家，游玩记录也不会被误判为购买记录。

内部请求示例：

```bash
curl --fail --request POST \
  --header "Authorization: Bearer ${SYNC_CRON_SECRET}" \
  --header "Idempotency-Key: playstation-20260714T080000Z" \
  --header "Content-Type: application/json" \
  --data-binary @integrations/examples/playstation-snapshot.example.json \
  https://inventory.example.com/api/v1/internal/platform-snapshot
```
