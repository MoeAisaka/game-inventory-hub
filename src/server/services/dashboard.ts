import { and, desc, eq, isNull } from "drizzle-orm";
import { type DashboardData, type DashboardFilters } from "@/lib/dashboard";
import { gameStatusLabels, statusesWithCompletion, type GameStatus } from "@/lib/game-status";
import { buildSteamMatchWorkbench } from "@/lib/steam-match-workbench";
import { db } from "@/server/db";
import { assets, externalAccounts, games, gameStatusAssignments, inventoryItems, steamLibraryItems } from "@/server/db/schema";

const statusLabels: Record<string, string> = { ...gameStatusLabels, UNSET: "未设置" };

const platformLabels: Record<string, string> = {
  STEAM: "Steam",
  PLAYSTATION: "PlayStation",
  NINTENDO_SWITCH: "Switch",
  NINTENDO_SWITCH_2: "Switch 2",
  XBOX_GAME_PASS: "XGP",
  PC_OTHER: "PC",
  IOS: "iOS",
  UNSET: "未设置"
};

type DashboardGame = {
  id: string;
  nameZh: string;
  platform: string | null;
  playStatus: string | null;
  isCompleted: boolean;
  statuses: GameStatus[];
  completedAt: string | null;
  progressPercent: number | null;
  playtimeMinutesManual: number | null;
  playtimeMinutesSynced: number;
  steamAppId: number | null;
};

export function buildDashboardGameMetrics(
  allGames: DashboardGame[],
  filters: DashboardFilters,
  now: Date = new Date()
) {
  const filtered = allGames.filter((game) => {
    if (filters.platform !== "ALL" && game.platform !== filters.platform) return false;
    if (filters.statuses.length && !game.statuses.some((status) => filters.statuses.includes(status))) return false;
    if (filters.scope === "STEAM_LINKED" && game.steamAppId === null) return false;
    return true;
  });
  const completedCount = filtered.filter((game) => game.isCompleted).length;
  const progressValues = filtered.flatMap((game) => game.progressPercent === null ? [] : [game.progressPercent]);
  const playtimeMinutes = filtered.reduce(
    (sum, game) => sum + (game.playtimeMinutesManual ?? game.playtimeMinutesSynced),
    0
  );
  const group = (values: Array<{ key: string; label: string }>) => values.reduce<Map<string, { key: string; label: string; value: number }>>(
    (map, item) => map.set(item.key, { ...item, value: (map.get(item.key)?.value ?? 0) + 1 }),
    new Map()
  );
  const statusDistribution = [...group(filtered.flatMap((game) => {
    const statuses = game.statuses.length ? game.statuses : ["UNSET"];
    return statuses.map((key) => ({ key, label: statusLabels[key] ?? key }));
  })).values()].sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "zh-CN"));
  const platformDistribution = [...group(filtered.map((game) => {
    const key = game.platform ?? "UNSET";
    return { key, label: platformLabels[key] ?? key };
  })).values()].sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "zh-CN"));
  const topGames = filtered.map((game) => ({
    id: game.id,
    name: game.nameZh,
    platform: game.platform,
    minutes: game.playtimeMinutesManual ?? game.playtimeMinutesSynced
  })).filter((game) => game.minutes > 0)
    .sort((left, right) => right.minutes - left.minutes || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 8);

  const completionYears = filtered.flatMap((game) => {
    const year = game.completedAt ? Number(game.completedAt.slice(0, 4)) : Number.NaN;
    return Number.isInteger(year) ? [year] : [];
  });
  const currentYear = now.getUTCFullYear();
  const minimumObserved = completionYears.length ? Math.min(...completionYears) : currentYear;
  const startYear = filters.completionWindow === "5Y" ? currentYear - 4
    : filters.completionWindow === "10Y" ? currentYear - 9
      : minimumObserved;
  const countsByYear = completionYears.reduce<Map<number, number>>(
    (map, year) => map.set(year, (map.get(year) ?? 0) + 1),
    new Map()
  );
  const completionTrend = Array.from(
    { length: Math.max(1, currentYear - startYear + 1) },
    (_, index) => ({ year: startYear + index, value: countsByYear.get(startYear + index) ?? 0 })
  );
  return {
    filtered,
    gameCount: filtered.length,
    completedCount,
    completionRate: filtered.length ? Math.round((completedCount / filtered.length) * 1000) / 10 : 0,
    playtimeMinutes,
    averageProgress: progressValues.length
      ? Math.round((progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length) * 10) / 10
      : null,
    statusDistribution,
    platformDistribution,
    topGames,
    completionTrend
  };
}

export async function getDashboardData(ownerUserId: string, filters: DashboardFilters): Promise<DashboardData> {
  const [gameRows, statusRows, assetRows, inventoryRows, steamRows, steamAccount] = await Promise.all([
    db.select({
      id: games.id,
      nameZh: games.nameZh,
      nameEn: games.nameEn,
      searchAliases: games.searchAliases,
      platform: games.platform,
      playStatus: games.playStatus,
      isCompleted: games.isCompleted,
      completedAt: games.completedAt,
      progressPercent: games.progressPercent,
      playtimeMinutesManual: games.playtimeMinutesManual,
      playtimeMinutesSynced: games.playtimeMinutesSynced,
      steamAppId: games.steamAppId
    }).from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select({ gameId: gameStatusAssignments.gameId, status: gameStatusAssignments.status })
      .from(gameStatusAssignments)
      .innerJoin(games, eq(games.id, gameStatusAssignments.gameId))
      .where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select({ id: assets.id }).from(assets).where(and(eq(assets.ownerUserId, ownerUserId), isNull(assets.deletedAt))),
    db.select({
      id: inventoryItems.id,
      unopenedQuantity: inventoryItems.unopenedQuantity,
      openedQuantity: inventoryItems.openedQuantity
    }).from(inventoryItems).where(and(eq(inventoryItems.ownerUserId, ownerUserId), isNull(inventoryItems.deletedAt))),
    db.select({
      steamAppId: steamLibraryItems.steamAppId,
      name: steamLibraryItems.name,
      playtimeMinutes: steamLibraryItems.playtimeMinutes,
      recentPlaytimeMinutes: steamLibraryItems.recentPlaytimeMinutes,
      lastPlayedAt: steamLibraryItems.lastPlayedAt,
      iconUrl: steamLibraryItems.iconUrl,
      matchMethod: steamLibraryItems.matchMethod,
      licenseType: steamLibraryItems.licenseType,
      matchStatus: steamLibraryItems.matchStatus
    }).from(steamLibraryItems).where(and(
      eq(steamLibraryItems.ownerUserId, ownerUserId),
      eq(steamLibraryItems.isOwned, true)
    )),
    db.select({ lastSyncedAt: externalAccounts.lastSyncedAt }).from(externalAccounts).where(and(
      eq(externalAccounts.ownerUserId, ownerUserId),
      eq(externalAccounts.provider, "STEAM")
    )).orderBy(desc(externalAccounts.updatedAt)).limit(1)
  ]);
  const statusesByGame = statusRows.reduce<Map<string, GameStatus[]>>((map, row) => {
    const statuses = map.get(row.gameId) ?? [];
    statuses.push(row.status);
    map.set(row.gameId, statuses);
    return map;
  }, new Map());
  const dashboardGames: DashboardGame[] = gameRows.map((game) => ({
    ...game,
    statuses: statusesWithCompletion(
      statusesByGame.get(game.id) ?? (game.playStatus ? [game.playStatus as GameStatus] : []),
      game.isCompleted
    )
  }));
  const gameMetrics = buildDashboardGameMetrics(dashboardGames, filters);
  const matched = steamRows.filter((item) => item.matchStatus === "MATCHED").length;
  const workbench = buildSteamMatchWorkbench(
    steamRows.filter((item) => item.matchStatus === "UNMATCHED"),
    gameRows.map((game) => ({
      id: game.id,
      nameZh: game.nameZh,
      nameEn: game.nameEn,
      platform: game.platform,
      steamAppId: game.steamAppId,
      searchAliases: game.searchAliases
    }))
  );
  const unmatched = workbench.counts.actionable;
  const ignored = steamRows.filter((item) => item.matchStatus === "IGNORED").length;
  return {
    filters,
    generatedAt: new Date().toISOString(),
    freshness: { steamLastSyncedAt: steamAccount[0]?.lastSyncedAt?.toISOString() ?? null },
    filterOptions: {
      platforms: [...new Set(dashboardGames.flatMap((game) => game.platform ? [game.platform] : []))].sort((a, b) => a.localeCompare(b, "zh-CN"))
    },
    metrics: {
      gameCount: gameMetrics.gameCount,
      completedCount: gameMetrics.completedCount,
      completionRate: gameMetrics.completionRate,
      playtimeMinutes: gameMetrics.playtimeMinutes,
      averageProgress: gameMetrics.averageProgress,
      assetCount: assetRows.length,
      inventorySkuCount: inventoryRows.length,
      inventoryUnitCount: inventoryRows.reduce((sum, item) => sum + item.unopenedQuantity + item.openedQuantity, 0)
    },
    statusDistribution: gameMetrics.statusDistribution,
    platformDistribution: gameMetrics.platformDistribution,
    topGames: gameMetrics.topGames,
    completionTrend: gameMetrics.completionTrend,
    steamCoverage: {
      total: steamRows.length,
      matched,
      unmatched,
      catalog: workbench.counts.CATALOG,
      ignored,
      coveragePercent: steamRows.length ? Math.round((matched / steamRows.length) * 1000) / 10 : 0
    }
  };
}
