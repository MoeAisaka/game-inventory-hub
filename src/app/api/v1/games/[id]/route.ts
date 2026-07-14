import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { deleteGame, getGame, updateGame, updateGameSchema } from "@/server/services/games";

const uuid = z.uuid();

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const params = await context.params;
  if (!uuid.safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  const game = await getGame(auth.userId, params.id);
  return game ? apiOk({ game }, 200, id) : apiError("NOT_FOUND", "游戏不存在", 404, id);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!uuid.safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  try {
    const parsed = updateGameSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "游戏参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await updateGame(auth.userId, params.id, parsed.data, id);
    if (!result) return apiError("NOT_FOUND", "游戏不存在", 404, id);
    if (result.conflict) return apiError("CONFLICT", "记录已被其他操作更新，请刷新后重试", 409, id, { current: result.current });
    return apiOk({ game: result.game }, 200, id);
  } catch (error) {
    if (error instanceof Error && error.message === "GAME_DATE_ORDER") {
      return apiError("INVALID_REQUEST", "完成日期不能早于开始日期", 400, id, { field: "completedAt" });
    }
    if (error instanceof Error && error.message === "GAME_QUEUE_STATUS") {
      return apiError("INVALID_REQUEST", "设置待玩顺序时必须同时选择“待玩”状态", 400, id, { field: "queueOrder" });
    }
    return apiError("INTERNAL_ERROR", "更新游戏失败", 500, id);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!uuid.safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  const game = await deleteGame(auth.userId, params.id, id);
  return game ? apiOk({ game }, 200, id) : apiError("NOT_FOUND", "游戏不存在", 404, id);
}
