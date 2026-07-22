import { asc } from "drizzle-orm";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { authorizedInternalRequest } from "@/server/http/internal-auth";
import {
  ingestSteamFamilySnapshot,
  SteamFamilySnapshotError,
  steamFamilySnapshotSchema
} from "@/server/integrations/steam-family";

export async function POST(request: Request) {
  const id = requestId(request);
  if (!authorizedInternalRequest(request)) return apiError("FORBIDDEN", "内部同步凭证无效", 403, id);
  let body: unknown;
  try {
    body = await safeJson(request);
  } catch {
    return apiError("INVALID_REQUEST", "请求必须是有效的JSON", 400, id);
  }
  const parsed = steamFamilySnapshotSchema.safeParse(body);
  if (!parsed.success) return apiError("INVALID_REQUEST", "家庭共享快照格式无效", 400, id, parsed.error.flatten());
  const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
  if (!owner) return apiError("PRECONDITION_FAILED", "尚未创建系统账号", 412, id);
  const idempotencyKey = request.headers.get("idempotency-key") ?? `steam-family-${parsed.data.familyGroupId}-${new Date().toISOString().slice(0, 10)}`;
  try {
    return apiOk(await ingestSteamFamilySnapshot(owner.id, parsed.data, idempotencyKey, id), 200, id);
  } catch (error) {
    if (error instanceof SteamFamilySnapshotError) {
      return apiError("PRECONDITION_FAILED", error.code === "ACCOUNT_MISSING" ? "请先配置Steam账号" : "快照SteamID与系统账号不一致", 412, id);
    }
    return apiError("INTERNAL_ERROR", "家庭共享快照写入失败", 500, id);
  }
}
