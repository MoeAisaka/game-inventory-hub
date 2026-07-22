import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getHomeData } from "@/server/services/home";
import { db } from "@/server/db";
import {
  gameAcquisitions,
  gamePlayPlans,
  games,
  gameStatusAssignments,
  platformLibraryItems,
  platformWishlistItems,
  users
} from "@/server/db/schema";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function main() {
  const [owner] = await db.select({ id: users.id }).from(users).orderBy(users.createdAt).limit(1);
  assert(owner, "VERIFY_OWNER_MISSING");
  const [playstation, nintendo, steam, wishlist, legacyWishlistStatus, plans, matchedNintendo] = await Promise.all([
    db.select({
      total: count(),
      subscription: sql<number>`count(*) filter (where ${gameAcquisitions.channel} = 'SUBSCRIPTION')`,
      unclassified: sql<number>`count(*) filter (where ${gameAcquisitions.channel} is null)`
    }).from(gameAcquisitions).where(and(eq(gameAcquisitions.ownerUserId, owner.id), eq(gameAcquisitions.source, "PLAYSTATION"))),
    db.select({
      total: count(),
      physical: sql<number>`count(*) filter (where ${gameAcquisitions.channel} = 'PHYSICAL')`,
      unclassified: sql<number>`count(*) filter (where ${gameAcquisitions.channel} is null)`
    }).from(gameAcquisitions).where(and(eq(gameAcquisitions.ownerUserId, owner.id), eq(gameAcquisitions.source, "NINTENDO"))),
    db.select({
      total: count(),
      classified: sql<number>`count(*) filter (where ${gameAcquisitions.channel} in ('SELF_PURCHASED','FAMILY_SHARED'))`,
      unclassified: sql<number>`count(*) filter (where ${gameAcquisitions.channel} is null)`
    }).from(gameAcquisitions).where(and(eq(gameAcquisitions.ownerUserId, owner.id), eq(gameAcquisitions.source, "STEAM"))),
    db.select({
      active: sql<number>`count(*) filter (where ${platformWishlistItems.isActive})`,
      legacyPlanned: sql<number>`count(*) filter (where ${platformWishlistItems.isActive} and ${isNotNull(platformWishlistItems.planOrder)})`
    }).from(platformWishlistItems).where(eq(platformWishlistItems.ownerUserId, owner.id)),
    db.select({ value: count() }).from(gameStatusAssignments)
      .innerJoin(games, eq(games.id, gameStatusAssignments.gameId))
      .where(and(eq(games.ownerUserId, owner.id), eq(gameStatusAssignments.status, "WISHLIST"), isNull(games.deletedAt))),
    db.select({ value: count() }).from(gamePlayPlans).where(eq(gamePlayPlans.ownerUserId, owner.id)),
    db.select({ value: count() }).from(platformLibraryItems).where(and(
      eq(platformLibraryItems.ownerUserId, owner.id),
      eq(platformLibraryItems.provider, "NINTENDO"),
      isNotNull(platformLibraryItems.matchedGameId)
    ))
  ]);

  assert(Number(playstation[0]?.total ?? 0) === Number(playstation[0]?.subscription ?? -1), "VERIFY_PLAYSTATION_DEFAULT_FAILED");
  assert(Number(playstation[0]?.unclassified ?? -1) === 0, "VERIFY_PLAYSTATION_UNCLASSIFIED");
  assert(Number(nintendo[0]?.total ?? 0) === Number(matchedNintendo[0]?.value ?? -1), "VERIFY_NINTENDO_COVERAGE_FAILED");
  assert(Number(nintendo[0]?.total ?? 0) === Number(nintendo[0]?.physical ?? -1), "VERIFY_NINTENDO_DEFAULT_FAILED");
  assert(Number(nintendo[0]?.unclassified ?? -1) === 0, "VERIFY_NINTENDO_UNCLASSIFIED");
  assert(Number(steam[0]?.total ?? 0) === Number(steam[0]?.classified ?? -1), "VERIFY_STEAM_CHANNEL_DRIFT");
  assert(Number(steam[0]?.unclassified ?? -1) === 0, "VERIFY_STEAM_UNCLASSIFIED");
  assert(Number(wishlist[0]?.legacyPlanned ?? -1) === 0, "VERIFY_WISHLIST_SPLIT_REMAINS");
  assert(Number(legacyWishlistStatus[0]?.value ?? -1) === 0, "VERIFY_LEGACY_WISHLIST_STATUS_REMAINS");

  const home = await getHomeData(owner.id);
  assert(home.currentQueue.length <= 2, "VERIFY_HOME_CURRENT_LIMIT");
  assert(home.nextQueue.length <= Number(plans[0]?.value ?? 0), "VERIFY_HOME_NEXT_PLAN_MISMATCH");
  assert(home.purchaseQueue.length <= home.metrics.purchaseCount, "VERIFY_HOME_PURCHASE_COUNT_MISMATCH");
  const channelRank = (channel: string | null) => ({
    SUBSCRIPTION: 0,
    FAMILY_SHARED: 1,
    PHYSICAL: 2,
    SELF_PURCHASED: 3
  }[channel ?? ""] ?? 99);
  assert(home.nextQueue.every((plan, index, rows) => index === 0
    || channelRank(rows[index - 1].channel) <= channelRank(plan.channel)), "VERIFY_HOME_CHANNEL_ORDER");

  console.log(JSON.stringify({
    playstation: playstation[0],
    nintendo: nintendo[0],
    steam: steam[0],
    wishlist: wishlist[0],
    plans: plans[0]?.value ?? 0,
    home: home.metrics
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
