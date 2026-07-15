import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { externalAccounts, externalGameMappings, games, platformLibraryItems, syncJobs } from "@/server/db/schema";

const nullableUrl = z.string().trim().url().refine((value) => /^https?:\/\//i.test(value)).nullable().optional();
const nullableDateTime = z.string().datetime({ offset: true }).nullable().optional();

export const platformSnapshotSchema = z.object({
  provider: z.enum(["PLAYSTATION", "NINTENDO"]),
  externalUserId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(200).nullable().optional(),
  items: z.array(z.object({
    externalGameId: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(300),
    platform: z.string().trim().max(100).nullable().optional(),
    coverUrl: nullableUrl,
    playtimeMinutes: z.number().int().min(0).default(0),
    firstPlayedAt: nullableDateTime,
    lastPlayedAt: nullableDateTime,
    progressPercent: z.number().int().min(0).max(100).nullable().optional(),
    isOwned: z.boolean().default(true),
    rawMetadata: z.record(z.string(), z.unknown()).default({})
  })).max(5000)
});

function normalizeTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[™®©]/g, "").replace(/[\p{P}\p{S}\s]+/gu, "");
}

export async function ingestPlatformSnapshot(ownerUserId: string, input: z.infer<typeof platformSnapshotSchema>, idempotencyKey: string, requestId: string = randomUUID()) {
  const existingJob = (await db.select().from(syncJobs).where(and(eq(syncJobs.ownerUserId, ownerUserId), eq(syncJobs.idempotencyKey, idempotencyKey))).limit(1))[0];
  if (existingJob) return { reused: true, job: existingJob };

  const [localGames, mappings] = await Promise.all([
    db.select({ id: games.id, nameZh: games.nameZh, nameEn: games.nameEn }).from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select().from(externalGameMappings).where(eq(externalGameMappings.provider, input.provider))
  ]);
  const mappingByExternalId = new Map(mappings.map((mapping) => [mapping.externalGameId, mapping.gameId]));
  const gamesByNormalizedName = new Map<string, string[]>();
  for (const game of localGames) {
    for (const title of [game.nameZh, game.nameEn].filter((value): value is string => Boolean(value))) {
      const key = normalizeTitle(title);
      if (!key) continue;
      gamesByNormalizedName.set(key, [...(gamesByNormalizedName.get(key) ?? []), game.id]);
    }
  }

  const result = await db.transaction(async (transaction) => {
    await transaction.insert(externalAccounts).values({
      ownerUserId,
      provider: input.provider,
      externalUserId: input.externalUserId,
      displayName: input.displayName ?? null,
      status: "ACTIVE",
      lastSyncedAt: new Date()
    }).onConflictDoUpdate({
      target: [externalAccounts.ownerUserId, externalAccounts.provider],
      set: { externalUserId: input.externalUserId, displayName: input.displayName ?? null, status: "ACTIVE", lastSyncedAt: new Date(), lastErrorCode: null, updatedAt: new Date() }
    });
    const [job] = await transaction.insert(syncJobs).values({
      ownerUserId,
      provider: input.provider,
      status: "RUNNING",
      idempotencyKey,
      processedCount: input.items.length,
      startedAt: new Date()
    }).returning();

    let matched = 0;
    let unresolved = 0;
    for (const item of input.items) {
      const mappedGameId = mappingByExternalId.get(item.externalGameId);
      const nameMatches = [...new Set(gamesByNormalizedName.get(normalizeTitle(item.name)) ?? [])];
      const matchedGameId = mappedGameId ?? (nameMatches.length === 1 ? nameMatches[0] : null);
      const matchMethod = mappedGameId ? "EXTERNAL_MAPPING" : matchedGameId ? "UNIQUE_NORMALIZED_NAME" : "UNMATCHED";
      const matchConfidence = mappedGameId ? 100 : matchedGameId ? 92 : 0;
      const matchStatus = matchedGameId ? "MATCHED" as const : "UNMATCHED" as const;
      if (matchedGameId) matched += 1;
      else unresolved += 1;
      await transaction.insert(platformLibraryItems).values({
        ownerUserId,
        provider: input.provider,
        externalGameId: item.externalGameId,
        name: item.name,
        platform: item.platform ?? null,
        coverUrl: item.coverUrl ?? null,
        playtimeMinutes: item.playtimeMinutes,
        firstPlayedAt: item.firstPlayedAt ? new Date(item.firstPlayedAt) : null,
        lastPlayedAt: item.lastPlayedAt ? new Date(item.lastPlayedAt) : null,
        progressPercent: item.progressPercent ?? null,
        isOwned: item.isOwned,
        matchStatus,
        matchedGameId,
        matchConfidence,
        matchMethod,
        rawMetadata: item.rawMetadata,
        lastSeenAt: new Date()
      }).onConflictDoUpdate({
        target: [platformLibraryItems.ownerUserId, platformLibraryItems.provider, platformLibraryItems.externalGameId],
        set: {
          name: item.name, platform: item.platform ?? null, coverUrl: item.coverUrl ?? null, playtimeMinutes: item.playtimeMinutes,
          firstPlayedAt: item.firstPlayedAt ? new Date(item.firstPlayedAt) : null, lastPlayedAt: item.lastPlayedAt ? new Date(item.lastPlayedAt) : null,
          progressPercent: item.progressPercent ?? null, isOwned: item.isOwned, matchStatus, matchedGameId, matchConfidence, matchMethod,
          rawMetadata: item.rawMetadata, lastSeenAt: new Date(), updatedAt: new Date()
        }
      });
    }
    const [completed] = await transaction.update(syncJobs).set({
      status: unresolved ? "PARTIAL" : "SUCCEEDED",
      updatedCount: matched,
      skippedCount: unresolved,
      completedAt: new Date(),
      updatedAt: new Date(),
      summary: { matched, unresolved, stagingOnly: true }
    }).where(eq(syncJobs.id, job.id)).returning();
    return { job: completed, matched, unresolved };
  });
  await writeAudit({ actorUserId: ownerUserId, action: "platform.snapshot.ingest", entityType: "sync_job", entityId: result.job.id, outcome: "SUCCESS", requestId, metadata: { provider: input.provider, processed: input.items.length, matched: result.matched, unresolved: result.unresolved } });
  return { reused: false, ...result };
}
