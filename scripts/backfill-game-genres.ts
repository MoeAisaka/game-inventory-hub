import { asc } from "drizzle-orm";
import { closeDatabase, db } from "@/server/db";
import { users } from "@/server/db/schema";
import { writeAudit } from "@/server/audit";
import { syncIgdbGenres } from "@/server/integrations/igdb";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const forceAll = process.argv.includes("--force");

const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
if (!owner) throw new Error("NO_OWNER");

try {
  const summary = { batches: 0, processed: 0, updated: 0, lockedSkipped: 0, unmapped: 0, complete: false };
  let cursor: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const result = await syncIgdbGenres(owner.id, `genre-backfill-${Date.now()}-${index}`, fetch, {
      missingOnly: !forceAll,
      afterId: cursor
    });
    if (result.reused) break;
    summary.batches += 1;
    summary.processed += result.processed;
    summary.updated += result.updated;
    summary.lockedSkipped += result.lockedSkipped;
    summary.unmapped += result.unmapped;
    console.log(JSON.stringify({ event: "batch", ...summary, result }));
    if (!result.hasMore || !result.lastCursor) {
      summary.complete = true;
      break;
    }
    cursor = result.lastCursor;
    await sleep(350);
  }
  await writeAudit({
    actorUserId: owner.id,
    action: "game.genres.backfill",
    entityType: "game_catalog",
    entityId: owner.id,
    outcome: "SUCCESS",
    requestId: `genre-backfill-${Date.now()}`,
    metadata: { forceAll, ...summary }
  });
  console.log(JSON.stringify({ event: "complete", forceAll, ...summary }));
} finally {
  await closeDatabase();
}
