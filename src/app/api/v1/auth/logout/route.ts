import { apiError, apiOk, requestId } from "@/lib/api";
import { writeAudit } from "@/server/audit";
import { getSession, revokeSession, SESSION_COOKIE_NAME, sessionCookie } from "@/server/auth/session";
import { sameOrigin } from "@/server/http/auth";

export async function POST(request: Request) {
  const id = requestId(request);
  if (!sameOrigin(request)) return apiError("FORBIDDEN", "请求来源校验失败", 403, id);
  const token = request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const session = await getSession(token);
  const revoked = await revokeSession(token);
  if (session && revoked) {
    await writeAudit({
      actorUserId: session.userId,
      action: "auth.logout",
      entityType: "session",
      entityId: session.sessionId,
      outcome: "SUCCESS",
      requestId: id
    });
  }
  const response = apiOk({ loggedOut: true }, 200, id);
  response.cookies.set({ ...sessionCookie(new Date(0)), value: "" });
  return response;
}
