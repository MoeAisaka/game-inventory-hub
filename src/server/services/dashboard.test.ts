import { describe, expect, it } from "vitest";
import type { GameStatus } from "@/lib/game-status";
import { buildDashboardGameMetrics } from "@/server/services/dashboard";

const records = [
  {
    id: "game-1",
    nameZh: "游戏一",
    platform: "STEAM",
    playStatus: "COMPLETED",
    statuses: ["COMPLETED"] as GameStatus[],
    completedAt: "2026-01-03",
    progressPercent: 100,
    playtimeMinutesManual: 120,
    playtimeMinutesSynced: 300,
    steamAppId: 1
  },
  {
    id: "game-2",
    nameZh: "游戏二",
    platform: "STEAM",
    playStatus: "PLAYING",
    statuses: ["PLAYING", "TO_BUY"] as GameStatus[],
    completedAt: null,
    progressPercent: 50,
    playtimeMinutesManual: null,
    playtimeMinutesSynced: 600,
    steamAppId: 2
  },
  {
    id: "game-3",
    nameZh: "游戏三",
    platform: "PLAYSTATION",
    playStatus: "BACKLOG",
    statuses: ["BACKLOG"] as GameStatus[],
    completedAt: null,
    progressPercent: null,
    playtimeMinutesManual: null,
    playtimeMinutesSynced: 0,
    steamAppId: null
  }
];

describe("dashboard aggregation", () => {
  it("uses manual playtime as the source of truth before synced playtime", () => {
    const result = buildDashboardGameMetrics(records, {
      platform: "ALL",
      statuses: [],
      scope: "ALL",
      completionWindow: "5Y"
    }, new Date("2026-07-13T00:00:00Z"));
    expect(result).toMatchObject({
      gameCount: 3,
      completedCount: 1,
      completionRate: 33.3,
      playtimeMinutes: 720,
      averageProgress: 75
    });
    expect(result.topGames.map((game) => game.id)).toEqual(["game-2", "game-1"]);
    expect(result.completionTrend).toEqual([
      { year: 2022, value: 0 },
      { year: 2023, value: 0 },
      { year: 2024, value: 0 },
      { year: 2025, value: 0 },
      { year: 2026, value: 1 }
    ]);
  });

  it("applies platform, status, and Steam linkage filters consistently", () => {
    const result = buildDashboardGameMetrics(records, {
      platform: "STEAM",
      statuses: ["PLAYING", "TO_BUY"],
      scope: "STEAM_LINKED",
      completionWindow: "10Y"
    }, new Date("2026-07-13T00:00:00Z"));
    expect(result).toMatchObject({ gameCount: 1, completedCount: 0, playtimeMinutes: 600, averageProgress: 50 });
    expect(result.statusDistribution).toEqual([
      { key: "TO_BUY", label: "待购入", value: 1 },
      { key: "PLAYING", label: "游玩中", value: 1 }
    ]);
    expect(result.platformDistribution).toEqual([{ key: "STEAM", label: "Steam", value: 1 }]);
  });
});
