import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";
import { rollbackMigrationBatch } from "@/server/migration/service";
import { sameOrigin } from "@/server/http/auth";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return apiError("AUTH_REQUIRED", "需要登录", 401, id);
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const params = await context.params;
    const batch = await rollbackMigrationBatch(params.id, session.userId, id);
    return apiOk({ batch }, 200, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "批次回滚失败";
    if (message === "导入批次不存在") return apiError("NOT_FOUND", message, 404, id);
    if (message.includes("已提交批次")) return apiError("CONFLICT", message, 409, id);
    return apiError("INTERNAL_ERROR", "批次回滚失败", 500, id);
  }
}
