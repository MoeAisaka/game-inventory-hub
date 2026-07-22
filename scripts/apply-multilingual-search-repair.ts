import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "@/server/db";
import {
  externalGameMappings,
  gameFieldLocks,
  gameReleaseEvents,
  games,
  platformWishlistItems,
  users
} from "@/server/db/schema";

const XENOBLADE_GAME_ID = "7e16db54-b728-57f6-b7c6-48c77df841b8";
const XENOBLADE_IGDB_ID = 321048;
const BEAST_STEAM_APP_ID = 2_001_760;

async function main() {
  const owner = (await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1))[0];
  if (!owner) throw new Error("OWNER_MISSING");
  const xenoblade = (await db.select().from(games).where(and(
    eq(games.id, XENOBLADE_GAME_ID),
    eq(games.ownerUserId, owner.id),
    isNull(games.deletedAt)
  )).limit(1))[0];
  if (!xenoblade || xenoblade.nameZh !== "異度神劍X 終極版") throw new Error("XENOBLADE_TARGET_MISMATCH");
  const activeBeast = await db.select({ id: games.id }).from(games).where(and(
    eq(games.ownerUserId, owner.id),
    eq(games.steamAppId, BEAST_STEAM_APP_ID),
    isNull(games.deletedAt)
  ));
  if (activeBeast.length) throw new Error("BEAST_ALREADY_IN_CATALOG");

  const result = await db.transaction(async (transaction) => {
    const now = new Date();
    const aliases = [
      "异度神剑X 终极版",
      "异度之刃X 终极版",
      "Xenoblade X",
      "Xenoblade Chronicles X Definitive Edition"
    ];
    const [updated] = await transaction.update(games).set({
      nameEn: "Xenoblade Chronicles X: Definitive Edition",
      nameEnSource: "MANUAL",
      searchAliases: aliases,
      igdbGameId: XENOBLADE_IGDB_ID,
      updatedAt: now,
      version: sql`${games.version} + 1`
    }).where(eq(games.id, xenoblade.id)).returning();
    await transaction.insert(gameFieldLocks).values({
      gameId: xenoblade.id,
      field: "NAME_EN",
      lockedByUserId: owner.id
    }).onConflictDoNothing();
    await transaction.insert(externalGameMappings).values({
      gameId: xenoblade.id,
      provider: "IGDB",
      externalGameId: String(XENOBLADE_IGDB_ID),
      matchConfidence: 100,
      manuallyConfirmed: true
    }).onConflictDoUpdate({
      target: [externalGameMappings.provider, externalGameMappings.externalGameId],
      set: { gameId: xenoblade.id, matchConfidence: 100, manuallyConfirmed: true, updatedAt: now }
    });
    await transaction.update(gameReleaseEvents).set({
      nameEn: updated.nameEn,
      updatedAt: now
    }).where(and(eq(gameReleaseEvents.ownerUserId, owner.id), eq(gameReleaseEvents.gameId, xenoblade.id)));
    const [wishlist] = await transaction.insert(platformWishlistItems).values({
      ownerUserId: owner.id,
      provider: "STEAM",
      externalGameId: String(BEAST_STEAM_APP_ID),
      name: "轮回之兽",
      platform: "STEAM",
      storeUrl: `https://store.steampowered.com/app/${BEAST_STEAM_APP_ID}/Beast_of_Reincarnation/`,
      isActive: true,
      rawMetadata: {
        nameEn: "Beast of Reincarnation",
        source: "STEAM_STORE",
        reason: "PRE_RELEASE_NOT_OWNED",
        verifiedAt: now.toISOString()
      },
      lastSeenAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [platformWishlistItems.ownerUserId, platformWishlistItems.provider, platformWishlistItems.externalGameId],
      set: {
        name: "轮回之兽",
        platform: "STEAM",
        storeUrl: `https://store.steampowered.com/app/${BEAST_STEAM_APP_ID}/Beast_of_Reincarnation/`,
        isActive: true,
        matchedGameId: null,
        rawMetadata: {
          nameEn: "Beast of Reincarnation",
          source: "STEAM_STORE",
          reason: "PRE_RELEASE_NOT_OWNED",
          verifiedAt: now.toISOString()
        },
        lastSeenAt: now,
        updatedAt: now
      }
    }).returning();
    return { updated, wishlist };
  });
  process.stdout.write(`${JSON.stringify({
    xenoblade: {
      id: result.updated.id,
      nameZh: result.updated.nameZh,
      nameEn: result.updated.nameEn,
      aliases: result.updated.searchAliases,
      igdbGameId: result.updated.igdbGameId
    },
    beastWishlist: {
      id: result.wishlist.id,
      externalGameId: result.wishlist.externalGameId,
      active: result.wishlist.isActive
    }
  }, null, 2)}\n`);
}

main().finally(() => pool.end());
