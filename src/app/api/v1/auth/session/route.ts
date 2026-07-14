import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return apiError("AUTH_REQUIRED", "需要登录", 401, id);
  return apiOk({ user: { id: session.userId, username: session.username }, expiresAt: session.expiresAt }, 200, id);
}
