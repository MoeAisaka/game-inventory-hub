import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { games, platformLibraryItems, steamLibraryItems } from "@/server/db/schema";
import { reconcileWishlistForGames } from "@/server/services/game-wishlist";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function later(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function earlier(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

export async function recomputeSyncedGameActivity(
  transaction: Transaction,
  ownerUserId: string,
  gameIds: string[],
  now: Date = new Date()
) {
  const ids = [...new Set(gameIds)];
  if (!ids.length) return { updatedGames: 0, withPositivePlaytime: 0 };
  const records = await transaction.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      inArray(games.id, ids),
      isNull(games.deletedAt)
    ));
  const steam = await transaction.select({
      gameId: steamLibraryItems.matchedGameId,
      playtimeMinutes: steamLibraryItems.playtimeMinutes,
      lastPlayedAt: steamLibraryItems.lastPlayedAt,
      firstObservedAt: steamLibraryItems.createdAt
    }).from(steamLibraryItems).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.isOwned, true),
      eq(steamLibraryItems.matchStatus, "MATCHED"),
      inArray(steamLibraryItems.matchedGameId, ids)
    ));
  const platform = await transaction.select({
      gameId: platformLibraryItems.matchedGameId,
      provider: platformLibraryItems.provider,
      playtimeMinutes: platformLibraryItems.playtimeMinutes,
      firstPlayedAt: platformLibraryItems.firstPlayedAt,
      lastPlayedAt: platformLibraryItems.lastPlayedAt,
      firstObservedAt: platformLibraryItems.createdAt
    }).from(platformLibraryItems).where(and(
      eq(platformLibraryItems.ownerUserId, ownerUserId),
      eq(platformLibraryItems.matchStatus, "MATCHED"),
      inArray(platformLibraryItems.matchedGameId, ids)
    ));

  let updatedGames = 0;
  let withPositivePlaytime = 0;
  for (const record of records) {
    const steamRows = steam.filter((row) => row.gameId === record.id);
    const platformRows = platform.filter((row) => row.gameId === record.id);
    if (!steamRows.length && !platformRows.length) continue;
    const steamMinutes = steamRows.reduce((sum, row) => sum + row.playtimeMinutes, 0);
    const providerMaximum = (provider: "PLAYSTATION" | "NINTENDO") => Math.max(
      0,
      ...platformRows.filter((row) => row.provider === provider).map((row) => row.playtimeMinutes)
    );
    const total = steamMinutes + providerMaximum("PLAYSTATION") + providerMaximum("NINTENDO");
    if (total > 0) withPositivePlaytime += 1;
    const sourceLast = [...steamRows.map((row) => row.lastPlayedAt), ...platformRows.map((row) => row.lastPlayedAt)]
      .reduce<Date | null>((current, value) => later(current, value), null);
    const sourceFirst = [
      ...steamRows.filter((row) => row.playtimeMinutes > 0).map((row) => row.firstObservedAt),
      ...platformRows.filter((row) => row.playtimeMinutes > 0).map((row) => row.firstPlayedAt ?? row.firstObservedAt)
    ].reduce<Date | null>((current, value) => earlier(current, value), null);
    await transaction.update(games).set({
      playtimeMinutesSynced: total,
      lastPlayedAt: later(record.lastPlayedAt, sourceLast),
      firstObservedPlayedAt: earlier(record.firstObservedPlayedAt, sourceFirst),
      playtimeLastChangedAt: total !== record.playtimeMinutesSynced ? now : record.playtimeLastChangedAt,
      updatedAt: now,
      version: sql`${games.version} + 1`
    }).where(and(eq(games.id, record.id), eq(games.ownerUserId, ownerUserId)));
    updatedGames += 1;
  }
  await reconcileWishlistForGames(transaction, ownerUserId, ids, now);
  return { updatedGames, withPositivePlaytime };
}
