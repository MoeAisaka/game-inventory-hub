import { z } from "zod";
import { apiError, apiOk, requestId, safeJson } from "@/lib/api";
import { login } from "@/server/auth/login";
import { sessionCookie } from "@/server/auth/session";
import { sameOrigin } from "@/server/http/auth";

const schema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(256)
});

export async function POST(request: Request) {
  const id = requestId(request);
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  try {
    const parsed = schema.safeParse(await safeJson(request));
    if (!parsed.success) {
      return apiError("INVALID_REQUEST", "请求参数不合法", 400, id, z.flattenError(parsed.error).fieldErrors);
    }
    const result = await login(parsed.data.username, parsed.data.password, id);
    if (!result.ok && result.reason === "INVALID_CREDENTIALS") {
      return apiError("AUTH_INVALID_CREDENTIALS", "用户名或密码错误", 401, id);
    }
    if (!result.ok) {
      const retryAfter = Math.max(1, Math.ceil((result.retryAt.getTime() - Date.now()) / 1000));
      const response = apiError("AUTH_RATE_LIMITED", "尝试次数过多，请稍后再试", 429, id, { retryAt: result.retryAt });
      response.headers.set("retry-after", String(retryAfter));
      return response;
    }
    const response = apiOk({ user: result.user }, 200, id);
    response.cookies.set({ ...sessionCookie(result.expiresAt), value: result.token });
    return response;
  } catch {
    return apiError("INTERNAL_ERROR", "登录服务暂时不可用", 500, id);
  }
}
