import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword } from "../src/server/auth/password";
import { closeDatabase, db } from "../src/server/db";
import { auditLogs, users } from "../src/server/db/schema";

const usernameArg = process.argv.find((value) => value.startsWith("--username="));
const username = (usernameArg?.slice("--username=".length) ?? "admin").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new Error("Username must be 3-64 lowercase ASCII characters");
if (!password || password.length < 12 || password.length > 256) throw new Error("ADMIN_PASSWORD must be 12-256 characters");

try {
  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ username, passwordHash })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash, updatedAt: sql`now()` }
    })
    .returning({ id: users.id, username: users.username });
  await db.insert(auditLogs).values({
    actorUserId: user.id,
    action: "user.bootstrap",
    entityType: "user",
    entityId: user.id,
    outcome: "SUCCESS",
    requestId: `bootstrap-${randomUUID()}`,
    metadata: { username: user.username }
  });
  console.log(`Admin user ready: ${user.username}`);
} finally {
  await closeDatabase();
}
