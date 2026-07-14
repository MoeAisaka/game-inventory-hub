import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { auditLogs, authLoginAttempts, sessions, users } from "@/server/db/schema";
import { verifyPassword } from "./password";
import { hashSessionToken, newSessionToken, sessionExpiry } from "./session";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function loginKey(username: string) {
  return createHash("sha256").update(username).digest("hex");
}

async function currentBlock(keyHash: string, now: Date) {
  const [attempt] = await db.select().from(authLoginAttempts).where(eq(authLoginAttempts.keyHash, keyHash)).limit(1);
  return attempt?.blockedUntil && attempt.blockedUntil > now ? attempt.blockedUntil : null;
}

async function registerFailure(keyHash: string, now: Date) {
  return db.transaction(async (tx) => {
    await tx.insert(authLoginAttempts).values({ keyHash }).onConflictDoNothing();
    const locked = await tx.execute<{
      failed_count: number;
      window_started_at: Date;
    }>(sql`SELECT failed_count, window_started_at FROM auth_login_attempts WHERE key_hash = ${keyHash} FOR UPDATE`);
    const attempt = locked.rows[0];
    const windowExpired = now.getTime() - new Date(attempt.window_started_at).getTime() >= WINDOW_MS;
    const failedCount = windowExpired ? 1 : Number(attempt.failed_count) + 1;
    const blockedUntil = failedCount >= MAX_FAILURES ? new Date(now.getTime() + WINDOW_MS) : null;
    await tx.update(authLoginAttempts).set({
      failedCount,
      windowStartedAt: windowExpired ? now : new Date(attempt.window_started_at),
      blockedUntil,
      updatedAt: now
    }).where(eq(authLoginAttempts.keyHash, keyHash));
    return blockedUntil;
  });
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; user: { id: string; username: string } }
  | { ok: false; reason: "INVALID_CREDENTIALS" }
  | { ok: false; reason: "RATE_LIMITED"; retryAt: Date };

export async function login(usernameInput: string, password: string, requestId: string): Promise<LoginResult> {
  const username = usernameInput.trim().toLowerCase();
  const keyHash = loginKey(username);
  const now = new Date();
  const blockedUntil = await currentBlock(keyHash, now);
  if (blockedUntil) return { ok: false, reason: "RATE_LIMITED", retryAt: blockedUntil };

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const passwordValid = await verifyPassword(user?.passwordHash ?? null, password);

  if (!user || !passwordValid) {
    const retryAt = await registerFailure(keyHash, now);
    await db.insert(auditLogs).values({
      action: "auth.login",
      entityType: "session",
      outcome: "FAILURE",
      requestId,
      metadata: { loginKeyHash: keyHash, rateLimited: Boolean(retryAt) }
    });
    return retryAt
      ? { ok: false, reason: "RATE_LIMITED", retryAt }
      : { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  const token = newSessionToken();
  const expiresAt = sessionExpiry(now);
  await db.transaction(async (tx) => {
    await tx.delete(authLoginAttempts).where(eq(authLoginAttempts.keyHash, keyHash));
    const [session] = await tx.insert(sessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt
    }).returning({ id: sessions.id });
    await tx.insert(auditLogs).values({
      actorUserId: user.id,
      action: "auth.login",
      entityType: "session",
      entityId: session.id,
      outcome: "SUCCESS",
      requestId,
      metadata: {}
    });
  });

  return { ok: true, token, expiresAt, user: { id: user.id, username: user.username } };
}
