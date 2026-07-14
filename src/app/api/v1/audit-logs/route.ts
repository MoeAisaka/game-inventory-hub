import { desc } from "drizzle-orm";
import { NextRequest } from "next/server";
import { apiError, apiOk, requestId } from "@/lib/api";
import { getSession, SESSION_COOKIE_NAME } from "@/server/auth/session";
import { db } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export async function GET(request: NextRequest) {
  const id = requestId(request);
  const session = await getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return apiError("AUTH_REQUIRED", "需要登录", 401, id);
  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 50));
  const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  return apiOk({ logs }, 200, id);
}
