import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { restoreGame } from "@/server/services/games";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const params = await context.params;
  if (!z.uuid().safeParse(params.id).success) return apiError("INVALID_REQUEST", "游戏ID不合法", 400, id);
  const game = await restoreGame(auth.userId, params.id, id);
  return game ? apiOk({ game }, 200, id) : apiError("NOT_FOUND", "游戏不存在", 404, id);
}
