import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

const globalDatabase = globalThis as unknown as { gameInventoryPool?: Pool };

export const pool = globalDatabase.gameInventoryPool ?? new Pool({
  connectionString: env().DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
  query_timeout: 6_000,
  application_name: "game-inventory-hub"
});

if (process.env.NODE_ENV !== "production") globalDatabase.gameInventoryPool = pool;

export const db = drizzle(pool, { schema });

export async function closeDatabase() {
  await pool.end();
  if (process.env.NODE_ENV !== "production") globalDatabase.gameInventoryPool = undefined;
}
