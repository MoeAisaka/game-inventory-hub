import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { auditLogs, fileBlobs } from "@/server/db/schema";

export const registerFileBlobSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(3).max(127),
  byteSize: z.number().int().min(0).max(5_000_000_000)
});

export async function registerFileBlob(
  input: z.infer<typeof registerFileBlobSchema>,
  actorUserId: string,
  requestId: string
) {
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(fileBlobs).values({
      ...input,
      createdByUserId: actorUserId
    }).onConflictDoNothing({ target: fileBlobs.checksumSha256 }).returning();
    const blob = inserted[0] ?? (await tx.select().from(fileBlobs)
      .where(eq(fileBlobs.checksumSha256, input.checksumSha256)).limit(1))[0];
    const created = Boolean(inserted[0]);
    if (created) {
      await tx.insert(auditLogs).values({
        actorUserId,
        action: "attachment.blob.register",
        entityType: "file_blob",
        entityId: blob.id,
        outcome: "SUCCESS",
        requestId,
        metadata: { checksumSha256: input.checksumSha256, byteSize: input.byteSize }
      });
    }
    return { blob, created };
  });
}
