import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import {
  auditLogs,
  gameAcquisitions,
  games,
  gameStatusAssignments,
  platformLibraryItems,
  platformWishlistItems,
  steamLibraryItems
} from "@/server/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const transitionStatuses = [
  "BACKLOG",
  "PLAYING",
  "PLAYED",
  "PAUSED",
  "ABANDONED",
  "UNPLANNED",
  "UNRELEASED",
  "TO_BUY",
  "WISHLIST"
] as const;

export type WishlistTransition = {
  gameId: string;
  from: "TO_BUY" | "WISHLIST";
  to: "BACKLOG" | "PLAYING";
  trigger: "OWNERSHIP" | "ACCESS" | "PLAY_ACTIVITY";
  wishlistItemIds?: string[];
};

function normalizeTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function providerMatchesGame(provider: string, record: typeof games.$inferSelect) {
  const platform = `${record.platform ?? ""} ${record.platformSource ?? ""}`.toUpperCase();
  if (provider === "STEAM") return Boolean(record.steamAppId) || platform.includes("STEAM");
  if (provider === "PLAYSTATION") return platform.includes("PLAYSTATION") || /(^|\s)PS[345](\s|$)/.test(platform);
  if (provider === "NINTENDO") return platform.includes("NINTENDO") || platform.includes("SWITCH");
  return false;
}

export async function reconcileWishlistForGames(
  transaction: Transaction,
  ownerUserId: string,
  gameIds: string[],
  now: Date = new Date()
) {
  const ids = [...new Set(gameIds)];
  if (!ids.length) return { transitions: [] as WishlistTransition[] };

  await transaction.execute(sql`
    SELECT ${games.id}
    FROM ${games}
    WHERE ${games.ownerUserId} = ${ownerUserId}
      AND ${games.deletedAt} IS NULL
      AND ${inArray(games.id, ids)}
    FOR UPDATE
  `);

  const [wished, externalWishlist, records, acquisitions, steamOwned, platformOwned] = await Promise.all([
    transaction.select({ gameId: gameStatusAssignments.gameId })
      .from(gameStatusAssignments)
      .where(and(
        inArray(gameStatusAssignments.gameId, ids),
        inArray(gameStatusAssignments.status, ["TO_BUY", "WISHLIST"])
      )),
    transaction.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, ownerUserId),
      eq(platformWishlistItems.isActive, true)
    )),
    transaction.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt),
      inArray(games.id, ids)
    )),
    transaction.select({ gameId: gameAcquisitions.gameId, isOwned: gameAcquisitions.isOwned }).from(gameAcquisitions).where(and(
      eq(gameAcquisitions.ownerUserId, ownerUserId),
      eq(gameAcquisitions.availability, "AVAILABLE"),
      inArray(gameAcquisitions.gameId, ids)
    )),
    transaction.select({ gameId: steamLibraryItems.matchedGameId }).from(steamLibraryItems).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.isOwned, true),
      eq(steamLibraryItems.licenseType, "OWNED"),
      eq(steamLibraryItems.matchStatus, "MATCHED"),
      inArray(steamLibraryItems.matchedGameId, ids)
    )),
    transaction.select({ gameId: platformLibraryItems.matchedGameId }).from(platformLibraryItems).where(and(
      eq(platformLibraryItems.ownerUserId, ownerUserId),
      eq(platformLibraryItems.isOwned, true),
      eq(platformLibraryItems.matchStatus, "MATCHED"),
      inArray(platformLibraryItems.matchedGameId, ids)
    ))
  ]);

  const wishedIds = new Set(wished.map((row) => row.gameId));
  const ownedIds = new Set([
    ...acquisitions.filter((row) => row.isOwned).map((row) => row.gameId),
    ...steamOwned.map((row) => row.gameId).filter((id): id is string => Boolean(id)),
    ...platformOwned.map((row) => row.gameId).filter((id): id is string => Boolean(id))
  ]);
  const accessibleIds = new Set(acquisitions.map((row) => row.gameId));
  const transitions: WishlistTransition[] = [];

  for (const record of records) {
    const recordNames = new Set([normalizeTitle(record.nameZh), normalizeTitle(record.nameEn ?? "")].filter(Boolean));
    const matchedWishlistItems = externalWishlist.filter((item) => item.matchedGameId === record.id
      || (item.provider === "STEAM" && record.steamAppId !== null && item.externalGameId === String(record.steamAppId))
      || (providerMatchesGame(item.provider, record) && recordNames.has(normalizeTitle(item.name))));
    if (matchedWishlistItems.length) {
      await transaction.update(platformWishlistItems).set({ matchedGameId: record.id, updatedAt: now }).where(and(
        eq(platformWishlistItems.ownerUserId, ownerUserId),
        inArray(platformWishlistItems.id, matchedWishlistItems.map((item) => item.id))
      ));
    }
    if (!wishedIds.has(record.id) && !matchedWishlistItems.length) continue;
    const hasPlayActivity = (record.playtimeMinutesManual ?? 0) > 0
      || record.playtimeMinutesSynced > 0
      || record.lastPlayedAt !== null
      || record.firstObservedPlayedAt !== null;
    const hasOwnership = record.ownershipStatus === "OWNED" || ownedIds.has(record.id);
    const hasAccess = hasOwnership || accessibleIds.has(record.id);
    if (!hasPlayActivity && !hasAccess) continue;

    const target = hasPlayActivity ? "PLAYING" as const : "BACKLOG" as const;
    const trigger = hasPlayActivity ? "PLAY_ACTIVITY" as const
      : hasOwnership ? "OWNERSHIP" as const
        : "ACCESS" as const;
    const inheritedPlanOrder = matchedWishlistItems
      .map((item) => item.planOrder)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0] ?? null;
    await transaction.delete(gameStatusAssignments).where(and(
      eq(gameStatusAssignments.gameId, record.id),
      inArray(gameStatusAssignments.status, transitionStatuses)
    ));
    await transaction.insert(gameStatusAssignments).values({ gameId: record.id, status: target });
    await transaction.update(games).set({
      playStatus: target,
      queueOrder: target === "BACKLOG" ? inheritedPlanOrder : null,
      updatedAt: now,
      version: sql`${games.version} + 1`
    }).where(and(eq(games.id, record.id), eq(games.ownerUserId, ownerUserId)));
    if (matchedWishlistItems.length) {
      await transaction.update(platformWishlistItems).set({
        matchedGameId: record.id,
        isActive: false,
        updatedAt: now
      }).where(and(
        eq(platformWishlistItems.ownerUserId, ownerUserId),
        inArray(platformWishlistItems.id, matchedWishlistItems.map((item) => item.id))
      ));
    }
    transitions.push({
      gameId: record.id,
      from: "TO_BUY",
      to: target,
      trigger,
      wishlistItemIds: matchedWishlistItems.map((item) => item.id)
    });
  }

  if (transitions.length) {
    await transaction.insert(auditLogs).values(transitions.map((transition) => ({
      actorUserId: ownerUserId,
      action: "game.wishlist.auto_transition",
      entityType: "game",
      entityId: transition.gameId,
      outcome: "SUCCESS" as const,
      requestId: randomUUID(),
      metadata: transition
    })));
  }
  return { transitions };
}
