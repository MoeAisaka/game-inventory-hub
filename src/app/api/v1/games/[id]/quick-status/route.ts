import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { quickGameStatusSchema, quickUpdateGameStatus } from "@/server/services/games";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  const parsed = quickGameStatusSchema.safeParse(await safeJson(request));
  if (!parsed.success) return apiError("INVALID_REQUEST", "快捷状态参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  try {
    const result = await quickUpdateGameStatus(auth.userId, params.id, parsed.data, id);
    if (!result) return apiError("NOT_FOUND", "游戏不存在", 404, id);
    if (result.conflict) return apiError("CONFLICT", "记录已被其他操作更新，请刷新后重试", 409, id, { current: result.current });
    return apiOk({ game: result.game, action: parsed.data.action }, 200, id);
  } catch {
    return apiError("INTERNAL_ERROR", "快捷状态更新失败", 500, id);
  }
}
