import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { saveSteamAccount, steamAccountSchema } from "@/server/integrations/accounts";

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = steamAccountSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "Steam账号参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    return apiOk({ account: await saveSteamAccount(auth.userId, parsed.data, id) }, 200, id);
  } catch {
    return apiError("INTERNAL_ERROR", "保存Steam账号失败", 500, id);
  }
}
