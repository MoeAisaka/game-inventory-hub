import { and, eq, isNull } from "drizzle-orm";
import type { HomeData, HomePurchaseItem } from "@/lib/home";
import type { PlannerPlan } from "@/lib/play-planning";
import { compareUnifiedNextQueue } from "@/lib/game-state-engine";
import { db } from "@/server/db";
import { games, gameStatusAssignments, platformWishlistItems } from "@/server/db/schema";
import { getPlayPlannerData } from "@/server/services/play-planning";

const providerLabels: Record<string, string> = {
  STEAM: "Steam",
  PLAYSTATION: "PlayStation",
  NINTENDO: "Nintendo",
  MANUAL: "手工"
};

function purchaseSort(left: HomePurchaseItem, right: HomePurchaseItem) {
  if (left.releaseDate && right.releaseDate && left.releaseDate !== right.releaseDate) {
    return left.releaseDate.localeCompare(right.releaseDate);
  }
  if (left.releaseDate !== right.releaseDate) return left.releaseDate ? -1 : 1;
  return left.nameZh.localeCompare(right.nameZh, "zh-CN");
}

export async function getHomeData(ownerUserId: string, now = new Date()): Promise<HomeData> {
  const [gameRows, statusRows, wishlistRows, planner] = await Promise.all([
    db.select().from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select({ gameId: gameStatusAssignments.gameId, status: gameStatusAssignments.status })
      .from(gameStatusAssignments)
      .innerJoin(games, eq(games.id, gameStatusAssignments.gameId))
      .where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, ownerUserId),
      eq(platformWishlistItems.isActive, true)
    )),
    getPlayPlannerData(ownerUserId, now)
  ]);

  const statusesByGame = statusRows.reduce<Map<string, Set<string>>>((map, row) => {
    const values = map.get(row.gameId) ?? new Set<string>();
    values.add(row.status);
    map.set(row.gameId, values);
    return map;
  }, new Map());
  const formalPurchaseGameIds = new Set<string>();
  const formalPurchases: HomePurchaseItem[] = gameRows.flatMap((game) => {
    const statuses = statusesByGame.get(game.id);
    if (!statuses?.has("TO_BUY") && !statuses?.has("WISHLIST")) return [];
    formalPurchaseGameIds.add(game.id);
    return [{
      kind: "GAME" as const,
      id: game.id,
      nameZh: game.nameZh,
      nameEn: game.nameEn,
      platform: game.platform,
      coverUrl: game.coverUrl,
      releaseDate: game.releaseDate,
      storeUrl: null,
      sourceLabel: "正式目录"
    }];
  });
  const externalPurchases: HomePurchaseItem[] = wishlistRows
    .filter((item) => !item.matchedGameId || !formalPurchaseGameIds.has(item.matchedGameId))
    .map((item) => ({
      kind: "WISHLIST" as const,
      id: item.id,
      nameZh: typeof item.rawMetadata?.nameZh === "string" ? item.rawMetadata.nameZh : item.name,
      nameEn: typeof item.rawMetadata?.nameEn === "string" ? item.rawMetadata.nameEn : null,
      platform: item.platform,
      coverUrl: item.coverUrl,
      releaseDate: item.releaseDate,
      storeUrl: item.storeUrl,
      sourceLabel: providerLabels[item.provider] ?? item.provider
    }));
  const purchaseItems = [...formalPurchases, ...externalPurchases].sort(purchaseSort);
  const currentQueue = [planner.scenarios.COMMUTE.current, planner.scenarios.FIXED.current]
    .filter((plan): plan is PlannerPlan => plan !== null);
  const nextQueue = [
    ...planner.scenarios.COMMUTE.queue,
    ...planner.scenarios.FIXED.queue
  ].sort(compareUnifiedNextQueue);
  const plannedGameIds = new Set([
    ...currentQueue.map((plan) => plan.gameId),
    ...nextQueue.map((plan) => plan.gameId)
  ]);
  const candidatePool = planner.candidates.filter((game) => !plannedGameIds.has(game.id));

  return {
    generatedAt: now.toISOString(),
    metrics: {
      activeCount: planner.counts.activeDistinct,
      plannedCount: planner.counts.queued,
      candidateCount: candidatePool.length,
      purchaseCount: purchaseItems.length
    },
    currentQueue,
    nextQueue: nextQueue.slice(0, 12),
    candidatePool: candidatePool.slice(0, 12),
    purchaseQueue: purchaseItems.slice(0, 12),
    playScenarios: {
      COMMUTE: {
        weeklyBudgetMinutes: planner.scenarios.COMMUTE.weeklyBudgetMinutes,
        current: planner.scenarios.COMMUTE.current,
        queue: planner.scenarios.COMMUTE.queue.slice(0, 12)
      },
      FIXED: {
        weeklyBudgetMinutes: planner.scenarios.FIXED.weeklyBudgetMinutes,
        current: planner.scenarios.FIXED.current,
        queue: planner.scenarios.FIXED.queue.slice(0, 12)
      }
    }
  };
}
