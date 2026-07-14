import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";
import { registerFileBlob, registerFileBlobSchema } from "@/server/services/attachments";
import { sameOrigin } from "@/server/http/auth";

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return apiError("AUTH_REQUIRED", "需要登录", 401, id);
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = registerFileBlobSchema.safeParse(await safeJson(request));
    if (!parsed.success) return apiError("INVALID_REQUEST", "附件元数据不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    const result = await registerFileBlob(parsed.data, session.userId, id);
    return apiOk(result, result.created ? 201 : 200, id);
  } catch {
    return apiError("INTERNAL_ERROR", "登记附件元数据失败", 500, id);
  }
}
