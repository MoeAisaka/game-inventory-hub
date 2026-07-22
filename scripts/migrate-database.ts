import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: process.env.DATABASE_URL });
const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });

await client.connect();
try {
  // Drizzle's PostgreSQL migrator wraps every pending migration in one large
  // transaction. PostgreSQL enum values cannot be used until the transaction
  // that added them commits, so an empty database fails when a later migration
  // consumes an earlier enum addition. A session lock plus one transaction per
  // migration preserves atomicity without crossing that PostgreSQL boundary.
  await client.query("SELECT pg_advisory_lock(hashtext('game_inventory_schema_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  const latest = await client.query<{ created_at: string | null }>(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
  );
  const lastAppliedAt = Number(latest.rows[0]?.created_at ?? 0);

  for (const migration of migrations) {
    if (migration.folderMillis <= lastAppliedAt) continue;
    await client.query("BEGIN");
    try {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [migration.hash, migration.folderMillis]
      );
      await client.query("COMMIT");
      console.log(`APPLIED ${migration.folderMillis}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('game_inventory_schema_migrations'))").catch(() => undefined);
  await client.end();
}
