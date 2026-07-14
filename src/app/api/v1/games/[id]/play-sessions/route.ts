import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { addPlaySession, playSessionSchema } from "@/server/services/games";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  try {
    const parsed = playSessionSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "游玩记录参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await addPlaySession(auth.userId, params.id, parsed.data, id);
    return result ? apiOk(result, 201, id) : apiError("NOT_FOUND", "游戏不存在", 404, id);
  } catch {
    return apiError("INTERNAL_ERROR", "新增游玩记录失败", 500, id);
  }
}
