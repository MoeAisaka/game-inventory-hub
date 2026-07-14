import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { commitMigrationBatch } from "@/server/migration/commit";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "批次ID不合法", 400, id);
  try {
    return apiOk(await commitMigrationBatch(params.id, auth.userId, id), 200, id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "IMPORT_BATCH_NOT_FOUND") return apiError("NOT_FOUND", "导入批次不存在", 404, id);
    if (code === "IMPORT_BATCH_NOT_READY") return apiError("PRECONDITION_FAILED", "批次尚未通过提交门禁", 412, id);
    if (code === "IMPORT_RECONCILIATION_FAILED") return apiError("PRECONDITION_FAILED", "批次数量对账失败", 412, id);
    return apiError("INTERNAL_ERROR", "提交迁移批次失败", 500, id);
  }
}
