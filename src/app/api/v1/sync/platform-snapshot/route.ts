import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { ingestPlatformSnapshot, platformSnapshotSchema } from "@/server/integrations/platform-snapshot";

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) return apiError("INVALID_REQUEST", "缺少合法幂等键", 400, id);
  const parsed = platformSnapshotSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "平台快照格式不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await ingestPlatformSnapshot(auth.userId, parsed.data, idempotencyKey, id), 200, id);
}
