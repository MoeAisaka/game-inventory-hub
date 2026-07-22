import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { createGame, createGameSchema, gameQuerySchema, listGames } from "@/server/services/games";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  const query: Record<string, string | string[]> = Object.fromEntries(request.nextUrl.searchParams);
  query.status = request.nextUrl.searchParams.getAll("status");
  query.platform = request.nextUrl.searchParams.getAll("platform");
  query.genre = request.nextUrl.searchParams.getAll("genre");
  const parsed = gameQuerySchema.safeParse(query);
  if (!parsed.success) return apiError("INVALID_REQUEST", "查询参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
  return apiOk(await listGames(auth.userId, parsed.data), 200, id);
}

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = createGameSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "游戏参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk({ game: await createGame(auth.userId, parsed.data, id) }, 201, id);
  } catch {
    return apiError("INTERNAL_ERROR", "创建游戏失败", 500, id);
  }
}
