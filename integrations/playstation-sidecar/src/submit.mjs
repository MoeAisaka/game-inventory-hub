import { SidecarError } from "./errors.mjs";

export async function submitSnapshot(config, preview) {
  if (!config.syncSecret) throw new SidecarError("SYNC_SECRET_REQUIRED", "提交模式需要 SYNC_CRON_SECRET");
  const response = await fetch(`${config.mainApiUrl}/api/v1/internal/platform-snapshot`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.syncSecret}`,
      "content-type": "application/json",
      "idempotency-key": preview.idempotencyKey
    },
    body: JSON.stringify(preview.snapshot)
  });
  if (!response.ok) {
    throw new SidecarError("MAIN_API_REJECTED", `主系统拒绝快照，HTTP ${response.status}`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  const payload = await response.json();
  return {
    requestId: payload?.requestId ?? null,
    reused: Boolean(payload?.data?.reused),
    jobId: payload?.data?.job?.id ?? null,
    matched: payload?.data?.matched ?? null,
    unresolved: payload?.data?.unresolved ?? null
  };
}
