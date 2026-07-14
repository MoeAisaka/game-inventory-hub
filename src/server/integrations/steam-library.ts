import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  externalGameMappings,
  gameAcquisitions,
  gameActivitySnapshots,
  games,
  gameStatusAssignments,
  steamLibraryItems
} from "@/server/db/schema";
import { steamEnglishNameCandidate } from "./steam";

export const resolveSteamLibrarySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("MATCH"), gameId: z.uuid() }),
  z.object({ action: z.literal("CREATE") }),
  z.object({ action: z.literal("IGNORE") })
]);

export class SteamLibraryResolutionError extends Error {
  constructor(public readonly code: "LIBRARY_ITEM_NOT_FOUND" | "GAME_NOT_FOUND" | "TARGET_ALREADY_LINKED" | "ITEM_ALREADY_MATCHED") {
    super(code);
  }
}

export async function steamLibraryOverview(ownerUserId: string) {
  const [items, localGames] = await Promise.all([
    db.select().from(steamLibraryItems).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.isOwned, true)
    )).orderBy(desc(steamLibraryItems.playtimeMinutes), asc(steamLibraryItems.name)),
    db.select({
      id: games.id,
      nameZh: games.nameZh,
      nameEn: games.nameEn,
      platform: games.platform,
      steamAppId: games.steamAppId
    }).from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt)
    )).orderBy(asc(games.nameZh))
  ]);
  const summary = {
    total: items.length,
    matched: items.filter((item) => item.matchStatus === "MATCHED").length,
    unmatched: items.filter((item) => item.matchStatus === "UNMATCHED").length,
    ignored: items.filter((item) => item.matchStatus === "IGNORED").length
  };
  return {
    summary,
    unresolved: items.filter((item) => item.matchStatus === "UNMATCHED").slice(0, 200),
    localGames
  };
}

export async function resolveSteamLibraryItem(
  ownerUserId: string,
  steamAppId: number,
  input: z.infer<typeof resolveSteamLibrarySchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    const item = (await transaction.select().from(steamLibraryItems).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.steamAppId, steamAppId),
      eq(steamLibraryItems.isOwned, true)
    )).limit(1))[0];
    if (!item) throw new SteamLibraryResolutionError("LIBRARY_ITEM_NOT_FOUND");

    if (input.action === "IGNORE") {
      if (item.matchStatus === "MATCHED") throw new SteamLibraryResolutionError("ITEM_ALREADY_MATCHED");
      const [updated] = await transaction.update(steamLibraryItems).set({
        matchStatus: "IGNORED",
        matchedGameId: null,
        matchConfidence: 0,
        matchMethod: "MANUAL_IGNORE",
        updatedAt: new Date()
      }).where(eq(steamLibraryItems.id, item.id)).returning();
      return { item: updated, game: null, action: input.action };
    }

    let target: typeof games.$inferSelect;
    if (input.action === "CREATE") {
      const initialStatus = item.playtimeMinutes > 0 ? "PLAYING" as const : "BACKLOG" as const;
      [target] = await transaction.insert(games).values({
        ownerUserId,
        nameZh: item.name,
        platform: "STEAM",
        platformSource: "STEAM",
        mediaType: "DIGITAL",
        ownershipStatus: "OWNED",
        playStatus: initialStatus,
        playtimeMinutesSynced: item.playtimeMinutes,
        lastPlayedAt: item.lastPlayedAt,
        coverUrl: item.iconUrl,
        coverUrlSource: item.iconUrl ? "STEAM" : null,
        firstObservedPlayedAt: item.playtimeMinutes > 0 ? item.createdAt : null,
        playtimeLastChangedAt: item.playtimeMinutes > 0 ? item.updatedAt : null,
        steamAppId: item.steamAppId
      }).returning();
      await transaction.insert(gameStatusAssignments).values({ gameId: target.id, status: initialStatus });
    } else {
      target = (await transaction.select().from(games).where(and(
        eq(games.id, input.gameId),
        eq(games.ownerUserId, ownerUserId),
        isNull(games.deletedAt)
      )).limit(1))[0];
      if (!target) throw new SteamLibraryResolutionError("GAME_NOT_FOUND");
      if (item.matchedGameId && item.matchedGameId !== target.id) {
        await transaction.delete(externalGameMappings).where(and(
          eq(externalGameMappings.gameId, item.matchedGameId),
          eq(externalGameMappings.provider, "STEAM"),
          eq(externalGameMappings.externalGameId, String(item.steamAppId))
        ));
      }
      [target] = await transaction.update(games).set({
        steamAppId: target.steamAppId ?? item.steamAppId,
        lastPlayedAt: item.lastPlayedAt && (!target.lastPlayedAt || item.lastPlayedAt > target.lastPlayedAt)
          ? item.lastPlayedAt
          : target.lastPlayedAt,
        coverUrl: target.coverUrl ?? item.iconUrl,
        coverUrlSource: target.coverUrl ? target.coverUrlSource : (item.iconUrl ? "STEAM" : target.coverUrlSource),
        platform: target.platform ?? "STEAM",
        platformSource: target.platform ? target.platformSource : "STEAM",
        ownershipStatus: target.ownershipStatus ?? "OWNED",
        nameEn: target.nameEn ?? steamEnglishNameCandidate(item.name, target.nameZh),
        nameEnSource: target.nameEn
          ? target.nameEnSource
          : (steamEnglishNameCandidate(item.name, target.nameZh) ? "STEAM" : target.nameEnSource),
        updatedAt: new Date(),
        version: sql`${games.version} + 1`
      }).where(and(eq(games.id, target.id), eq(games.ownerUserId, ownerUserId))).returning();
    }

    await transaction.insert(externalGameMappings).values({
      gameId: target.id,
      provider: "STEAM",
      externalGameId: String(item.steamAppId),
      matchConfidence: 100,
      manuallyConfirmed: true
    }).onConflictDoUpdate({
      target: [externalGameMappings.provider, externalGameMappings.externalGameId],
      set: {
        gameId: target.id,
        matchConfidence: 100,
        manuallyConfirmed: true,
        updatedAt: new Date()
      }
    });
    const now = new Date();
    await transaction.insert(gameAcquisitions).values({
      ownerUserId,
      gameId: target.id,
      source: "STEAM",
      externalAcquisitionId: String(item.steamAppId),
      isOwned: true,
      details: { steamAppId: item.steamAppId, title: item.name },
      lastConfirmedAt: now
    }).onConflictDoUpdate({
      target: [gameAcquisitions.ownerUserId, gameAcquisitions.source, gameAcquisitions.externalAcquisitionId],
      set: { gameId: target.id, isOwned: true, lastConfirmedAt: now, updatedAt: now }
    });
    await transaction.insert(gameActivitySnapshots).values({
      ownerUserId,
      gameId: target.id,
      provider: "STEAM",
      externalGameId: String(item.steamAppId),
      totalPlaytimeMinutes: item.playtimeMinutes,
      recentPlaytimeMinutes: item.recentPlaytimeMinutes,
      lastPlayedAt: item.lastPlayedAt,
      observedAt: now
    }).onConflictDoNothing();
    const [updatedItem] = await transaction.update(steamLibraryItems).set({
      matchStatus: "MATCHED",
      matchedGameId: target.id,
      matchConfidence: 100,
      matchMethod: input.action === "CREATE" ? "MANUAL_CREATE" : "MANUAL",
      updatedAt: new Date()
    }).where(eq(steamLibraryItems.id, item.id)).returning();

    const aggregate = async (gameId: string) => {
      const totals = (await transaction.select({
        playtimeMinutes: sql<number>`coalesce(sum(${steamLibraryItems.playtimeMinutes}), 0)::int`,
        lastPlayedAt: sql<Date | string | null>`max(${steamLibraryItems.lastPlayedAt})`
      }).from(steamLibraryItems).where(and(
        eq(steamLibraryItems.ownerUserId, ownerUserId),
        eq(steamLibraryItems.matchedGameId, gameId),
        eq(steamLibraryItems.matchStatus, "MATCHED"),
        eq(steamLibraryItems.isOwned, true)
      )))[0];
      const existing = (await transaction.select().from(games).where(and(
        eq(games.id, gameId),
        eq(games.ownerUserId, ownerUserId),
        isNull(games.deletedAt)
      )).limit(1))[0];
      if (!existing) return null;
      const aggregateLastPlayedAt = totals.lastPlayedAt ? new Date(totals.lastPlayedAt) : null;
      const latest = aggregateLastPlayedAt && (!existing.lastPlayedAt || aggregateLastPlayedAt > existing.lastPlayedAt)
        ? aggregateLastPlayedAt
        : existing.lastPlayedAt;
      return (await transaction.update(games).set({
        playtimeMinutesSynced: totals.playtimeMinutes,
        lastPlayedAt: latest,
        firstObservedPlayedAt: existing.firstObservedPlayedAt
          ?? (totals.playtimeMinutes > 0 ? item.createdAt : null),
        playtimeLastChangedAt: totals.playtimeMinutes !== existing.playtimeMinutesSynced
          ? now
          : existing.playtimeLastChangedAt,
        ownershipStatus: "OWNED",
        updatedAt: new Date(),
        version: sql`${games.version} + 1`
      }).where(eq(games.id, gameId)).returning())[0];
    };

    const previousGameId = item.matchedGameId && item.matchedGameId !== target.id ? item.matchedGameId : null;
    const refreshedTarget = await aggregate(target.id);
    if (previousGameId) await aggregate(previousGameId);
    return { item: updatedItem, game: refreshedTarget ?? target, action: input.action };
  });

  await writeAudit({
    actorUserId: ownerUserId,
    action: input.action === "MATCH" ? "steam_library.match" : input.action === "CREATE" ? "steam_library.create_game" : "steam_library.ignore",
    entityType: "steam_library_item",
    entityId: result.item.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { steamAppId, gameId: result.game?.id ?? null }
  });
  return result;
}
