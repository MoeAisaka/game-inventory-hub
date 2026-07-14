import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import {
  resolveSteamLibraryItem,
  resolveSteamLibrarySchema,
  SteamLibraryResolutionError
} from "@/server/integrations/steam-library";

const appIdSchema = z.coerce.number().int().positive();

export async function POST(request: NextRequest, context: { params: Promise<{ appId: string }> }) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const parsedAppId = appIdSchema.safeParse((await context.params).appId);
  if (!parsedAppId.success) return apiError("INVALID_REQUEST", "Steam App ID不合法", 400, id);
  try {
    const parsed = resolveSteamLibrarySchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "Steam匹配参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk(await resolveSteamLibraryItem(auth.userId, parsedAppId.data, parsed.data, id), 200, id);
  } catch (error) {
    if (error instanceof SteamLibraryResolutionError) {
      if (error.code === "LIBRARY_ITEM_NOT_FOUND") return apiError("NOT_FOUND", "Steam游戏记录不存在", 404, id);
      if (error.code === "GAME_NOT_FOUND") return apiError("NOT_FOUND", "本地游戏记录不存在", 404, id);
      if (error.code === "ITEM_ALREADY_MATCHED") return apiError("CONFLICT", "该Steam游戏已匹配，不能直接忽略", 409, id);
      if (error.code === "TARGET_ALREADY_LINKED") return apiError("CONFLICT", "目标游戏已关联其他Steam记录", 409, id);
    }
    return apiError("INTERNAL_ERROR", "Steam匹配操作失败", 500, id);
  }
}
