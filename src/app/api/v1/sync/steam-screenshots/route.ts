import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { requireApiSession, sameOrigin } from "@/server/http/auth";
import { syncSteamScreenshots } from "@/server/integrations/steam-screenshots";
import { MediaStorageError } from "@/server/media/storage";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const id = requestId(request);
  const auth = await requireApiSession(request, id);
  if (auth instanceof Response) return auth;
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 150) {
    return apiError("INVALID_REQUEST", "需要8至150字符的Idempotency-Key", 400, id);
  }
  try {
    return apiOk(await syncSteamScreenshots(auth.userId, id, idempotencyKey), 200, id);
  } catch (error) {
    if (error instanceof MediaStorageError && error.code === "STEAM_ACCOUNT_REQUIRED") {
      return apiError("PRECONDITION_FAILED", error.message, 412, id);
    }
    if (error instanceof MediaStorageError) {
      return apiError("DEPENDENCY_UNAVAILABLE", error.message, 503, id, { mediaCode: error.code });
    }
    return apiError("DEPENDENCY_UNAVAILABLE", "Steam 截图同步暂时不可用", 503, id);
  }
}
