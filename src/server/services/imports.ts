import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { auditLogs, importBatches } from "@/server/db/schema";

export const createImportBatchSchema = z.object({
  sourceName: z.string().trim().min(1).max(255),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  sourceByteSize: z.number().int().min(0).max(5_000_000_000),
  totalRows: z.number().int().min(0).max(1_000_000).default(0)
});

export async function createImportBatch(
  input: z.infer<typeof createImportBatchSchema>,
  actorUserId: string,
  requestId: string
) {
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(importBatches).values({
      ...input,
      createdByUserId: actorUserId
    }).onConflictDoNothing({ target: importBatches.sourceChecksum }).returning();

    const batch = inserted[0] ?? (await tx.select().from(importBatches)
      .where(eq(importBatches.sourceChecksum, input.sourceChecksum)).limit(1))[0];
    const created = Boolean(inserted[0]);

    if (created) {
      await tx.insert(auditLogs).values({
        actorUserId,
        action: "import.batch.create",
        entityType: "import_batch",
        entityId: batch.id,
        outcome: "SUCCESS",
        requestId,
        metadata: { sourceChecksum: input.sourceChecksum, sourceByteSize: input.sourceByteSize }
      });
    }
    return { batch, created };
  });
}
