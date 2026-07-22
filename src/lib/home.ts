import { z } from "zod";
import type { GameStatus } from "@/lib/game-status";
import type { PlannerGame, PlannerPlan, PlayScenario } from "@/lib/play-planning";

export const homeQueuePreferencesSchema = z.object({
  showCandidatePool: z.boolean().default(false)
});

export type HomeQueuePreferences = z.infer<typeof homeQueuePreferencesSchema>;

export const defaultHomeQueuePreferences: HomeQueuePreferences = { showCandidatePool: false };

export function parseHomeQueuePreferences(value: unknown): HomeQueuePreferences {
  const parsed = homeQueuePreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultHomeQueuePreferences;
}

const HOME_TIME_ZONE = "Asia/Shanghai";

function homeDateParts(value: string, dateOnly = false) {
  const date = new Date(dateOnly ? `${value.slice(0, 10)}T00:00:00+08:00` : value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOME_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: String(Number(part("month"))),
    day: String(Number(part("day"))),
    hour: part("hour"),
    minute: part("minute")
  };
}

export function formatHomeMonthDay(value: string) {
  const parts = homeDateParts(value, true);
  return `${parts.month}/${parts.day}`;
}

export function formatHomeMonthDayTime(value: string) {
  const parts = homeDateParts(value);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatHomeDate(value: string) {
  const parts = homeDateParts(value);
  return `${parts.year}/${parts.month}/${parts.day}`;
}

export type HomeGame = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  coverUrl: string | null;
  statuses: GameStatus[];
  version: number;
  lastPlayedAt: string | null;
  totalPlaytimeMinutes: number;
  estimatedNormallyMinutes: number | null;
  queueOrder: number | null;
  reason?: string;
};

export type HomeNextGame = HomeGame & {
  kind: "GAME";
  planOrder: number | null;
};

export type HomeNextWishlist = {
  kind: "WISHLIST";
  id: string;
  nameZh: string;
  platform: string | null;
  releaseDate: string | null;
  storeUrl: string | null;
  planOrder: number;
  reason: string;
};

export type HomeNextItem = HomeNextGame | HomeNextWishlist;

export type HomeRelease = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string;
  releaseDate: string;
  isWishlisted: boolean;
};

export type HomePurchaseItem = {
  kind: "GAME" | "WISHLIST";
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  storeUrl: string | null;
  sourceLabel: string;
};

export type HomeData = {
  generatedAt: string;
  metrics: {
    activeCount: number;
    plannedCount: number;
    candidateCount: number;
    purchaseCount: number;
  };
  currentQueue: PlannerPlan[];
  nextQueue: PlannerPlan[];
  candidatePool: PlannerGame[];
  purchaseQueue: HomePurchaseItem[];
  playScenarios: Record<PlayScenario, {
    weeklyBudgetMinutes: number;
    current: PlannerPlan | null;
    queue: PlannerPlan[];
  }>;
};
