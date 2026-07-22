import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { IgdbConnectorError, syncIgdbReleaseCatalog } from "@/server/integrations/igdb";

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) return apiError("INVALID_REQUEST", "需要8至200字符的Idempotency-Key", 400, id);
  try {
    return apiOk(await syncIgdbReleaseCatalog(auth.userId, idempotencyKey), 200, id);
  } catch (error) {
    if (error instanceof IgdbConnectorError && error.code === "NOT_CONFIGURED") return apiError("NOT_CONFIGURED", "尚未配置IGDB客户端凭证", 412, id);
    return apiError("DEPENDENCY_UNAVAILABLE", "公共发售目录暂时不可用", 503, id);
  }
}
