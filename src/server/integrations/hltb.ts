import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { HowLongToBeatService, SearchModifier, type HowLongToBeatEntry } from "howlongtobeat-ts";
import { db } from "@/server/db";
import { metadataSearchVariants } from "@/server/integrations/igdb";
import {
  externalGameMappings,
  gameFieldLocks,
  gameMetadataCandidates,
  games,
  syncJobs
} from "@/server/db/schema";

type HltbClient = Pick<HowLongToBeatService, "search" | "getById">;

export class HltbConnectorError extends Error {
  constructor(public readonly code: "UPSTREAM_FAILED") {
    super(code);
  }
}

export function normalizedHltbTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\s:：·・'’"“”™®©\-—_.,，。!！?？()[\]{}]/g, "");
}

function candidateNames(candidate: HowLongToBeatEntry) {
  return [candidate.name, ...candidate.alias.split(/[;,|\n]/)].map((value) => value.trim()).filter(Boolean);
}

export function uniqueExactHltbCandidate(
  names: Array<string | null>,
  releaseDate: string | null,
  candidates: HowLongToBeatEntry[]
) {
  const normalizedNames = new Set(names.filter((value): value is string => Boolean(value)).map(normalizedHltbTitle));
  const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : null;
  const exact = candidates.filter((candidate) => {
    if (!candidateNames(candidate).some((name) => normalizedNames.has(normalizedHltbTitle(name)))) return false;
    if (releaseYear && candidate.releaseYear && Math.abs(candidate.releaseYear - releaseYear) > 1) return false;
    return true;
  });
  return exact.length === 1 ? exact[0] : null;
}

export function hltbSecondsToMinutes(value: number | undefined) {
  return value === undefined ? null : Math.round(value / 60);
}

function sourceUrl(id: number) {
  return `https://howlongtobeat.com/game/${id}`;
}

export async function syncHltbMetadata(
  ownerUserId: string,
  idempotencyKey: string,
  client: HltbClient = new HowLongToBeatService({ minSimilarity: 0.82, timeout: 15_000, retries: 1 }),
  options: { retryBefore?: Date } = {}
) {
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "HLTB",
    idempotencyKey,
    status: "RUNNING",
    startedAt: new Date()
  }).onConflictDoNothing().returning();
  const job = createdJob ?? (await db.select().from(syncJobs).where(and(
    eq(syncJobs.ownerUserId, ownerUserId),
    eq(syncJobs.idempotencyKey, idempotencyKey)
  )).limit(1))[0];
  if (!createdJob) return { reused: true, job };

  try {
    const retryBefore = options.retryBefore ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pending = await db.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt),
      or(
        isNull(games.estimatedHastilyMinutes),
        isNull(games.estimatedNormallyMinutes),
        isNull(games.estimatedCompletelyMinutes)
      ),
      or(isNull(games.hltbLastAttemptAt), lt(games.hltbLastAttemptAt, retryBefore))
    )).orderBy(asc(games.id)).limit(6);

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const game of pending) {
      try {
        let candidate: HowLongToBeatEntry | null = null;
        if (game.hltbGameId) {
          const result = await client.getById(game.hltbGameId);
          if (!result.success) throw new HltbConnectorError("UPSTREAM_FAILED");
          candidate = result.data;
        } else {
          for (const searchName of metadataSearchVariants([game.nameEn, game.nameZh])) {
            const result = await client.search(searchName, { modifier: SearchModifier.HIDE_DLC });
            if (!result.success) throw new HltbConnectorError("UPSTREAM_FAILED");
            candidate = uniqueExactHltbCandidate([game.nameEn, game.nameZh], game.releaseDate, result.data);
            if (candidate) break;
          }
        }
        if (!candidate) {
          skipped += 1;
          await db.update(games).set({ hltbLastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(games.id, game.id));
          continue;
        }

        const main = hltbSecondsToMinutes(candidate.mainTime);
        const extra = hltbSecondsToMinutes(candidate.mainExtraTime);
        const complete = hltbSecondsToMinutes(candidate.completionistTime);
        await db.transaction(async (transaction) => {
          const locks = new Set((await transaction.select({ field: gameFieldLocks.field })
            .from(gameFieldLocks).where(eq(gameFieldLocks.gameId, game.id))).map((lock) => lock.field));
          const patch: Record<string, unknown> = {
            hltbGameId: candidate.id,
            hltbLastAttemptAt: new Date(),
            updatedAt: new Date(),
            version: sql`${games.version} + 1`
          };
          let applied = false;
          if (!locks.has("MAIN_STORY_MINUTES") && main !== null) { patch.estimatedHastilyMinutes = main; applied = true; }
          if (!locks.has("EXTRA_STORY_MINUTES") && extra !== null) { patch.estimatedNormallyMinutes = extra; applied = true; }
          if (!locks.has("COMPLETIONIST_MINUTES") && complete !== null) { patch.estimatedCompletelyMinutes = complete; applied = true; }
          if (applied) patch.estimateSource = "HLTB";
          await transaction.update(games).set(patch).where(eq(games.id, game.id));
          await transaction.insert(externalGameMappings).values({
            gameId: game.id,
            provider: "HLTB",
            externalGameId: String(candidate.id),
            matchConfidence: 100,
            manuallyConfirmed: false
          }).onConflictDoUpdate({
            target: [externalGameMappings.provider, externalGameMappings.externalGameId],
            set: { gameId: game.id, updatedAt: new Date() }
          });
          const fields = [
            ["MAIN_STORY_MINUTES", main, candidate.mainCount],
            ["EXTRA_STORY_MINUTES", extra, candidate.mainExtraCount],
            ["COMPLETIONIST_MINUTES", complete, candidate.completionistCount]
          ] as const;
          for (const [field, value, count] of fields) {
            if (value === null) continue;
            await transaction.insert(gameMetadataCandidates).values({
              ownerUserId,
              gameId: game.id,
              provider: "HLTB",
              externalGameId: String(candidate.id),
              field,
              value: { value, sourceUrl: sourceUrl(candidate.id), sourceLabel: `HowLongToBeat · ${count ?? 0} 份样本` },
              confidence: 100,
              status: "APPLIED",
              appliedAt: new Date(),
              fetchedAt: new Date()
            }).onConflictDoUpdate({
              target: [gameMetadataCandidates.gameId, gameMetadataCandidates.provider, gameMetadataCandidates.externalGameId, gameMetadataCandidates.field],
              set: { value: { value, sourceUrl: sourceUrl(candidate.id), sourceLabel: `HowLongToBeat · ${count ?? 0} 份样本` }, confidence: 100, status: "APPLIED", appliedAt: new Date(), fetchedAt: new Date(), updatedAt: new Date() }
            });
          }
        });
        updated += 1;
      } catch {
        failed += 1;
        await db.update(games).set({ hltbLastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(games.id, game.id));
      }
    }

    const status = failed || skipped ? "PARTIAL" : "SUCCEEDED";
    await db.update(syncJobs).set({
      status,
      processedCount: pending.length,
      updatedCount: updated,
      skippedCount: skipped + failed,
      summary: { batchLimit: 6, hasMore: pending.length === 6, exactMatchOnly: true, failed },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return { reused: false, jobId: job.id, processed: pending.length, updated, skipped, failed, hasMore: pending.length === 6 };
  } catch (error) {
    await db.update(syncJobs).set({ status: "FAILED", errorCode: "UPSTREAM_FAILED", errorMessage: "HowLongToBeat 同步失败", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }
}
