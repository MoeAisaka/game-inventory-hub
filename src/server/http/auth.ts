import { NextRequest } from "next/server";
import { apiError } from "@/lib/api";
import { env } from "@/lib/env";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";

export async function requireApiSession(request: NextRequest, requestId: string) {
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return session ?? apiError("AUTH_REQUIRED", "需要登录", 401, requestId);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const appOrigin = env().APP_ORIGIN;
    const expected = appOrigin ? new URL(appOrigin).origin : new URL(request.url).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
