import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import { sessions, users } from "@/server/db/schema";

export const SESSION_COOKIE_NAME = "game_inventory_session";

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function sessionExpiry(now = new Date()) {
  return new Date(now.getTime() + env().SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function sessionCookie(expires: Date) {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: env().SESSION_COOKIE_SECURE,
    sameSite: "lax" as const,
    path: "/",
    expires
  };
}

export async function getSession(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      username: users.username,
      expiresAt: sessions.expiresAt
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.tokenHash, hashSessionToken(token)),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, new Date())
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSession(token: string | undefined) {
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return false;
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id, userId: sessions.userId });
  return result[0] ?? false;
}
