import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { SteamConnectorError } from "@/server/integrations/steam";
import { syncSteamWishlist } from "@/server/integrations/steam-wishlist";

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) return apiError("INVALID_REQUEST", "需要8至200字符的Idempotency-Key", 400, id);
  try {
    return apiOk(await syncSteamWishlist(auth.userId, idempotencyKey), 200, id);
  } catch (error) {
    if (error instanceof SteamConnectorError && error.code === "NOT_CONFIGURED") return apiError("NOT_CONFIGURED", "尚未配置Steam Web API密钥", 412, id);
    if (error instanceof SteamConnectorError && error.code === "ACCOUNT_MISSING") return apiError("PRECONDITION_FAILED", "尚未绑定SteamID64", 412, id);
    return apiError("DEPENDENCY_UNAVAILABLE", "Steam愿望单暂时不可用", 503, id);
  }
}
