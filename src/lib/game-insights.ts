import type { GameStatus } from "@/lib/game-status";

export const activityStateValues = [
  "NOT_STARTED",
  "PLAYING",
  "COMPLETION_CANDIDATE",
  "COMPLETED_CONFIRMED",
  "PAUSED",
  "ABANDONED"
] as const;

export type ActivityState = typeof activityStateValues[number];

export const activityStateLabels: Record<ActivityState, string> = {
  NOT_STARTED: "未开始",
  PLAYING: "游玩中",
  COMPLETION_CANDIDATE: "待确认通关",
  COMPLETED_CONFIRMED: "已通关",
  PAUSED: "已暂停",
  ABANDONED: "已放弃"
};

export type PurchaseState = "OWNED" | "TO_BUY" | "UNKNOWN";

export const purchaseStateLabels: Record<PurchaseState, string> = {
  OWNED: "已购入",
  TO_BUY: "待购入",
  UNKNOWN: "未登记"
};

export function deriveActivityState(input: {
  statuses: GameStatus[];
  totalPlaytimeMinutes: number;
  lastPlayedAt: Date | string | null;
  playtimeLastChangedAt: Date | string | null;
  now?: Date;
  inactivityHours?: number;
}): ActivityState {
  if (input.statuses.includes("COMPLETED")) return "COMPLETED_CONFIRMED";
  if (input.statuses.includes("ABANDONED")) return "ABANDONED";
  if (input.statuses.includes("PAUSED")) return "PAUSED";
  if (input.totalPlaytimeMinutes <= 0) return "NOT_STARTED";
  const reference = input.playtimeLastChangedAt ?? input.lastPlayedAt;
  if (!reference) return "COMPLETION_CANDIDATE";
  const timestamp = reference instanceof Date ? reference.getTime() : new Date(reference).getTime();
  if (!Number.isFinite(timestamp)) return "COMPLETION_CANDIDATE";
  const threshold = (input.inactivityHours ?? 48) * 60 * 60 * 1000;
  return (input.now ?? new Date()).getTime() - timestamp <= threshold
    ? "PLAYING"
    : "COMPLETION_CANDIDATE";
}

export function derivePurchaseState(input: {
  hasAcquisition: boolean;
  ownershipStatus: string | null;
  statuses: GameStatus[];
}): PurchaseState {
  if (input.hasAcquisition || input.ownershipStatus === "OWNED") return "OWNED";
  if (input.statuses.includes("TO_BUY")) return "TO_BUY";
  return "UNKNOWN";
}
