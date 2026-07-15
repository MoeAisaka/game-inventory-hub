import { asc } from "drizzle-orm";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { authorizedInternalRequest } from "@/server/http/internal-auth";
import { ingestPlatformSnapshot, platformSnapshotSchema } from "@/server/integrations/platform-snapshot";

export async function POST(request: Request) {
  const id = requestId(request);
  if (!authorizedInternalRequest(request)) return apiError("FORBIDDEN", "内部同步凭证无效", 403, id);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError("INVALID_REQUEST", "缺少合法幂等键", 400, id);
  }
  const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
  if (!owner) return apiError("PRECONDITION_FAILED", "尚未创建系统账号", 412, id);
  const parsed = platformSnapshotSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "平台快照格式不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  }
  return apiOk(await ingestPlatformSnapshot(owner.id, parsed.data, idempotencyKey, id), 200, id);
}
