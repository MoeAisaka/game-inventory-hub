import { eq } from "drizzle-orm";
import { hashPassword } from "../src/server/auth/password";
import { closeDatabase, db } from "../src/server/db";
import { users } from "../src/server/db/schema";

const username = (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "";

if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new Error("ADMIN_USERNAME must be 3-64 safe lowercase characters");
if (password.length < 12 || password.length > 256) throw new Error("ADMIN_PASSWORD must be 12-256 characters");

try {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing.length) throw new Error("user already exists");
  await db.insert(users).values({ username, passwordHash: await hashPassword(password) });
  console.log(`created user: ${username}`);
} finally {
  await closeDatabase();
}
