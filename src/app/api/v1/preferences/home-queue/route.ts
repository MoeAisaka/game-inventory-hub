import { NextRequest } from "next/server";
import { z } from "zod";
import { homeQueuePreferencesSchema } from "@/lib/home";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { getHomeQueuePreferences, saveHomeQueuePreferences } from "@/server/services/preferences";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  return apiOk({ preferences: await getHomeQueuePreferences(auth.userId) }, 200, id);
}

export async function PUT(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = homeQueuePreferencesSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "今日页偏好参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    await saveHomeQueuePreferences(auth.userId, parsed.data, id);
    return apiOk({ preferences: parsed.data }, 200, id);
  } catch {
    return apiError("INVALID_REQUEST", "无法保存今日页偏好", 400, id);
  }
}
