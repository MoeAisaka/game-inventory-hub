import { z } from "zod";
import { gameStatusValues, uniqueGameStatuses } from "@/lib/game-status";

const dashboardStatus = z.enum(gameStatusValues);

const dashboardFiltersObject = z.object({
  platform: z.string().trim().min(1).max(60).default("ALL"),
  statuses: z.array(dashboardStatus).max(gameStatusValues.length).transform(uniqueGameStatuses).default([]),
  scope: z.enum(["ALL", "STEAM_LINKED"]).default("ALL"),
  completionWindow: z.enum(["5Y", "10Y", "ALL"]).default("10Y")
});

export const dashboardFiltersSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const rawStatuses = input.statuses;
  const statuses = Array.isArray(rawStatuses)
    ? rawStatuses
    : typeof rawStatuses === "string"
      ? rawStatuses.split(",").map((item) => item.trim()).filter(Boolean)
      : typeof input.status === "string" && input.status !== "ALL"
        ? [input.status]
        : [];
  return { ...input, statuses };
}, dashboardFiltersObject);

export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;

export const defaultDashboardFilters: DashboardFilters = {
  platform: "ALL",
  statuses: [],
  scope: "ALL",
  completionWindow: "10Y"
};

export function parseDashboardFilters(value: unknown): DashboardFilters {
  const parsed = dashboardFiltersSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultDashboardFilters;
}

export type DashboardData = {
  filters: DashboardFilters;
  generatedAt: string;
  freshness: {
    steamLastSyncedAt: string | null;
  };
  filterOptions: {
    platforms: string[];
  };
  metrics: {
    gameCount: number;
    completedCount: number;
    completionRate: number;
    playtimeMinutes: number;
    averageProgress: number | null;
    assetCount: number;
    inventorySkuCount: number;
    inventoryUnitCount: number;
  };
  statusDistribution: Array<{ key: string; label: string; value: number }>;
  platformDistribution: Array<{ key: string; label: string; value: number }>;
  topGames: Array<{ id: string; name: string; platform: string | null; minutes: number }>;
  completionTrend: Array<{ year: number; value: number }>;
  steamCoverage: {
    total: number;
    matched: number;
    unmatched: number;
    catalog: number;
    ignored: number;
    coveragePercent: number;
  };
};
