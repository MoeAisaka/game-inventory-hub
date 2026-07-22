import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { gameSearchVariants } from "@/lib/game-search";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  externalGameMappings,
  gameAcquisitions,
  gameActivitySnapshots,
  games,
  steamLibraryItems,
  syncJobs
} from "@/server/db/schema";
import { autoClassifyPlayedGames } from "@/server/services/game-auto-status";
import { recomputeSyncedGameActivity } from "@/server/services/game-activity";
import { reconcileWishlistForGames } from "@/server/services/game-wishlist";
import { getExternalAccount } from "./accounts";
import { normalizeSteamTitle, steamEnglishNameCandidate, uniqueSteamNameCandidate } from "./steam";

const nullableDateTime = z.string().datetime({ offset: true }).nullable().optional();

export const steamFamilySnapshotSchema = z.object({
  steamId: z.string().regex(/^\d{17}$/),
  familyGroupId: z.string().trim().min(1).max(100),
  items: z.array(z.object({
    appId: z.number().int().positive(),
    name: z.string().trim().min(1).max(300),
    ownerSteamIds: z.array(z.string().regex(/^\d{17}$/)).max(20).transform((values) => [...new Set(values)]),
    excludeReason: z.number().int().min(0).default(0),
    playtimeMinutes: z.number().int().min(0).default(0),
    lastPlayedAt: nullableDateTime,
    iconUrl: z.string().url().startsWith("https://").nullable().optional(),
    rawMetadata: z.record(z.string(), z.unknown()).default({})
  })).max(20_000)
});

export class SteamFamilySnapshotError extends Error {
  constructor(public readonly code: "ACCOUNT_MISSING" | "ACCOUNT_MISMATCH") {
    super(code);
  }
}

export async function ingestSteamFamilySnapshot(
  ownerUserId: string,
  input: z.infer<typeof steamFamilySnapshotSchema>,
  idempotencyKey: string,
  requestId: string = randomUUID()
) {
  const account = await getExternalAccount(ownerUserId, "STEAM");
  if (!account) throw new SteamFamilySnapshotError("ACCOUNT_MISSING");
  if (account.externalUserId !== input.steamId) throw new SteamFamilySnapshotError("ACCOUNT_MISMATCH");
  const existingJob = (await db.select().from(syncJobs).where(and(
    eq(syncJobs.ownerUserId, ownerUserId),
    eq(syncJobs.idempotencyKey, idempotencyKey)
  )).limit(1))[0];
  if (existingJob) return { reused: true, job: existingJob };

  const [localGames, mappings, priorItems] = await Promise.all([
    db.select().from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select().from(externalGameMappings).where(eq(externalGameMappings.provider, "STEAM")),
    db.select().from(steamLibraryItems).where(eq(steamLibraryItems.ownerUserId, ownerUserId))
  ]);
  const gamesById = new Map(localGames.map((game) => [game.id, game]));
  const gamesByAppId = new Map(localGames.filter((game) => game.steamAppId !== null).map((game) => [game.steamAppId!, game]));
  const mappingByAppId = new Map(mappings
    .filter((mapping) => gamesById.has(mapping.gameId))
    .map((mapping) => [Number(mapping.externalGameId), mapping.gameId]));
  const priorByAppId = new Map(priorItems.map((item) => [item.steamAppId, item]));
  const gamesByNormalizedTitle = new Map<string, typeof localGames>();
  for (const game of localGames) {
    for (const title of [game.nameZh, game.nameEn, ...game.searchAliases]) {
      if (!title) continue;
      for (const variant of gameSearchVariants(title)) {
        const normalized = normalizeSteamTitle(variant);
        if (!normalized) continue;
        const bucket = gamesByNormalizedTitle.get(normalized) ?? [];
        if (!bucket.some((candidate) => candidate.id === game.id)) bucket.push(game);
        gamesByNormalizedTitle.set(normalized, bucket);
      }
    }
  }

  const result = await db.transaction(async (transaction) => {
    const now = new Date();
    const [job] = await transaction.insert(syncJobs).values({
      ownerUserId,
      provider: "STEAM",
      status: "RUNNING",
      idempotencyKey,
      processedCount: input.items.length,
      startedAt: now
    }).returning();
    await transaction.update(steamLibraryItems).set({ isOwned: false, updatedAt: now }).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.licenseType, "FAMILY_SHARED")
    ));

    let matched = 0;
    let unmatched = 0;
    let unavailable = 0;
    let ownedPrecedence = 0;
    const affectedGameIds = new Set(priorItems
      .filter((item) => item.licenseType === "FAMILY_SHARED")
      .map((item) => item.matchedGameId)
      .filter((value): value is string => Boolean(value)));

    for (const item of input.items) {
      const prior = priorByAppId.get(item.appId);
      if (prior?.licenseType === "OWNED" && prior.isOwned) {
        ownedPrecedence += 1;
        continue;
      }
      const mappedGameId = mappingByAppId.get(item.appId);
      const priorMatchedGame = prior?.matchedGameId ? gamesById.get(prior.matchedGameId) : undefined;
      const exactCandidates = [...new Map(gameSearchVariants(item.name)
        .flatMap((variant) => gamesByNormalizedTitle.get(normalizeSteamTitle(variant)) ?? [])
        .map((candidate) => [candidate.id, candidate])).values()]
        .filter((candidate) => candidate.steamAppId === null || candidate.steamAppId === item.appId);
      const matchedGame = gamesByAppId.get(item.appId)
        ?? (mappedGameId ? gamesById.get(mappedGameId) : undefined)
        ?? priorMatchedGame
        ?? uniqueSteamNameCandidate(exactCandidates);
      const available = item.excludeReason === 0;
      if (!available) unavailable += 1;
      if (matchedGame) {
        matched += 1;
        affectedGameIds.add(matchedGame.id);
      } else if (available) {
        unmatched += 1;
      }
      const matchStatus = matchedGame ? "MATCHED" as const
        : prior?.matchStatus === "IGNORED" ? "IGNORED" as const
          : "UNMATCHED" as const;
      const matchMethod = matchedGame
        ? gamesByAppId.has(item.appId) ? "APP_ID"
          : mappedGameId ? "EXTERNAL_MAPPING"
            : priorMatchedGame ? prior!.matchMethod
              : "UNIQUE_EXACT_TITLE"
        : prior?.matchStatus === "IGNORED" ? "MANUAL_IGNORE"
          : exactCandidates.length > 1 ? "AMBIGUOUS_EXACT_TITLE" : "NO_MATCH";
      const lastPlayedAt = item.lastPlayedAt ? new Date(item.lastPlayedAt) : null;

      await transaction.insert(steamLibraryItems).values({
        ownerUserId,
        steamAppId: item.appId,
        name: item.name,
        normalizedName: normalizeSteamTitle(item.name),
        playtimeMinutes: item.playtimeMinutes,
        lastPlayedAt,
        iconUrl: item.iconUrl ?? null,
        matchStatus,
        matchedGameId: matchedGame?.id ?? null,
        matchConfidence: matchedGame ? 95 : 0,
        matchMethod,
        licenseType: "FAMILY_SHARED",
        licenseOwnerSteamIds: item.ownerSteamIds,
        familyGroupId: input.familyGroupId,
        excludeReason: item.excludeReason,
        isOwned: available,
        lastSeenJobId: job.id,
        lastSeenAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [steamLibraryItems.ownerUserId, steamLibraryItems.steamAppId],
        set: {
          name: item.name,
          normalizedName: normalizeSteamTitle(item.name),
          playtimeMinutes: item.playtimeMinutes,
          lastPlayedAt,
          iconUrl: item.iconUrl ?? null,
          matchStatus,
          matchedGameId: matchedGame?.id ?? null,
          matchConfidence: matchedGame ? 95 : 0,
          matchMethod,
          licenseType: "FAMILY_SHARED",
          licenseOwnerSteamIds: item.ownerSteamIds,
          familyGroupId: input.familyGroupId,
          excludeReason: item.excludeReason,
          isOwned: available,
          lastSeenJobId: job.id,
          lastSeenAt: now,
          updatedAt: now
        }
      });

      if (!matchedGame) continue;
      await transaction.insert(externalGameMappings).values({
        gameId: matchedGame.id,
        provider: "STEAM",
        externalGameId: String(item.appId),
        matchConfidence: 95,
        manuallyConfirmed: false
      }).onConflictDoUpdate({
        target: [externalGameMappings.provider, externalGameMappings.externalGameId],
        set: { gameId: matchedGame.id, matchConfidence: 95, updatedAt: now }
      });
      const englishName = matchedGame.nameEn ? null : steamEnglishNameCandidate(item.name, matchedGame.nameZh);
      await transaction.update(games).set({
        steamAppId: matchedGame.steamAppId ?? item.appId,
        platform: matchedGame.platform ?? "STEAM",
        platformSource: matchedGame.platform ? matchedGame.platformSource : "STEAM",
        ownershipStatus: matchedGame.ownershipStatus === "OWNED" ? "OWNED" : "FAMILY_SHARED",
        nameEn: matchedGame.nameEn ?? englishName,
        nameEnSource: matchedGame.nameEn ? matchedGame.nameEnSource : (englishName ? "STEAM" : matchedGame.nameEnSource),
        coverUrl: matchedGame.coverUrl ?? item.iconUrl ?? null,
        coverUrlSource: matchedGame.coverUrl ? matchedGame.coverUrlSource : (item.iconUrl ? "STEAM" : matchedGame.coverUrlSource),
        updatedAt: now,
        version: sql`${games.version} + 1`
      }).where(eq(games.id, matchedGame.id));
      await transaction.insert(gameAcquisitions).values({
        ownerUserId,
        gameId: matchedGame.id,
        source: "STEAM",
        externalAcquisitionId: String(item.appId),
        channel: "FAMILY_SHARED",
        platform: "STEAM",
        availability: available ? "AVAILABLE" : "TEMPORARILY_UNAVAILABLE",
        offlineCapable: false,
        isOwned: false,
        details: {
          steamAppId: item.appId,
          title: item.name,
          accessType: "FAMILY_SHARED",
          ownerSteamIds: item.ownerSteamIds,
          familyGroupId: input.familyGroupId,
          available,
          excludeReason: item.excludeReason
        },
        lastConfirmedAt: now
      }).onConflictDoUpdate({
        target: [gameAcquisitions.ownerUserId, gameAcquisitions.source, gameAcquisitions.externalAcquisitionId],
        set: {
          gameId: matchedGame.id,
          isOwned: false,
          channel: "FAMILY_SHARED",
          platform: "STEAM",
          availability: available ? "AVAILABLE" : "TEMPORARILY_UNAVAILABLE",
          offlineCapable: false,
          details: {
            steamAppId: item.appId,
            title: item.name,
            accessType: "FAMILY_SHARED",
            ownerSteamIds: item.ownerSteamIds,
            familyGroupId: input.familyGroupId,
            available,
            excludeReason: item.excludeReason
          },
          lastConfirmedAt: now,
          updatedAt: now,
          version: sql`${gameAcquisitions.version} + 1`
        }
      });
      if (available && (!prior || prior.playtimeMinutes !== item.playtimeMinutes
        || (prior.lastPlayedAt?.getTime() ?? null) !== (lastPlayedAt?.getTime() ?? null))) {
        await transaction.insert(gameActivitySnapshots).values({
          ownerUserId,
          gameId: matchedGame.id,
          provider: "STEAM",
          externalGameId: String(item.appId),
          totalPlaytimeMinutes: item.playtimeMinutes,
          lastPlayedAt,
          observedAt: now
        });
      }
    }

    const activity = await recomputeSyncedGameActivity(transaction, ownerUserId, [...affectedGameIds], now);
    await reconcileWishlistForGames(transaction, ownerUserId, [...affectedGameIds], now);
    const [completed] = await transaction.update(syncJobs).set({
      status: unmatched > 0 ? "PARTIAL" : "SUCCEEDED",
      updatedCount: matched,
      skippedCount: unmatched + unavailable + ownedPrecedence,
      summary: { matched, unmatched, unavailable, ownedPrecedence, familyGroupId: input.familyGroupId, ...activity },
      completedAt: now,
      updatedAt: now
    }).where(eq(syncJobs.id, job.id)).returning();
    return { job: completed, matched, unmatched, unavailable, ownedPrecedence, ...activity };
  });

  const autoPlayed = await autoClassifyPlayedGames(ownerUserId);
  await writeAudit({
    actorUserId: ownerUserId,
    action: "steam_family.snapshot.ingest",
    entityType: "sync_job",
    entityId: result.job.id,
    outcome: "SUCCESS",
    requestId,
    metadata: {
      processed: input.items.length,
      matched: result.matched,
      unmatched: result.unmatched,
      unavailable: result.unavailable,
      ownedPrecedence: result.ownedPrecedence
    }
  });
  return { reused: false, ...result, autoPlayed };
}
