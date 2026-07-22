import { NextRequest } from "next/server";
import { apiError } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";

export async function requireApiSession(request: NextRequest, requestId: string) {
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return session ?? apiError("AUTH_REQUIRED", "需要登录", 401, requestId);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
