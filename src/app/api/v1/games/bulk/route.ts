import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson, type ApiErrorCode } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { bulkGameSchema, bulkManageGames } from "@/server/services/games";

const bulkErrors: Record<string, { code: ApiErrorCode; message: string; status: number }> = {
  BULK_SELECTION_STALE: { code: "CONFLICT", message: "筛选结果或所选记录已变化，请刷新后重试", status: 409 },
  BULK_SELECTION_EMPTY: { code: "INVALID_REQUEST", message: "没有可操作的游戏", status: 400 },
  BULK_SELECTION_LIMIT: { code: "INVALID_REQUEST", message: "单次最多批量操作 1000 款游戏", status: 400 },
  BULK_QUEUE_RANGE: { code: "INVALID_REQUEST", message: "接下来玩序号超出 1～9999，请调整起始值或步长", status: 400 }
};

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = bulkGameSchema.safeParse(await safeJson(request));
    if (!parsed.success) {
      return apiError("INVALID_REQUEST", "批量操作参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    }
    return apiOk(await bulkManageGames(auth.userId, parsed.data, id), 200, id);
  } catch (error) {
    const mapped = error instanceof Error ? bulkErrors[error.message] : undefined;
    if (mapped) return apiError(mapped.code, mapped.message, mapped.status, id);
    return apiError("INTERNAL_ERROR", "批量操作失败", 500, id);
  }
}
