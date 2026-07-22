import type { GameStatus } from "@/lib/game-status";

export const acquisitionChannelValues = ["SUBSCRIPTION", "FAMILY_SHARED", "PHYSICAL", "SELF_PURCHASED"] as const;
export const acquisitionAvailabilityValues = ["AVAILABLE", "TEMPORARILY_UNAVAILABLE", "EXPIRED"] as const;
export const playScenarioValues = ["COMMUTE", "FIXED"] as const;
export const completionGoalValues = ["MAIN", "EXTRA", "COMPLETE"] as const;

export type AcquisitionChannel = typeof acquisitionChannelValues[number];
export type AcquisitionAvailability = typeof acquisitionAvailabilityValues[number];
export type PlayScenario = typeof playScenarioValues[number];
export type CompletionGoal = typeof completionGoalValues[number];
export type PlayQueueState = "QUEUED" | "PLAYING";

export const acquisitionChannelLabels: Record<AcquisitionChannel, string> = {
  SUBSCRIPTION: "会免",
  FAMILY_SHARED: "家庭",
  PHYSICAL: "实体",
  SELF_PURCHASED: "自购"
};

export const acquisitionAvailabilityLabels: Record<AcquisitionAvailability, string> = {
  AVAILABLE: "当前可用",
  TEMPORARILY_UNAVAILABLE: "暂不可用",
  EXPIRED: "已失效"
};

export const playScenarioLabels: Record<PlayScenario, string> = {
  COMMUTE: "通勤便携",
  FIXED: "固定／串流"
};

export const completionGoalLabels: Record<CompletionGoal, string> = {
  MAIN: "主线",
  EXTRA: "主线＋支线",
  COMPLETE: "全收集"
};

export const acquisitionChannelRank: Record<AcquisitionChannel, number> = {
  SUBSCRIPTION: 0,
  FAMILY_SHARED: 1,
  PHYSICAL: 2,
  SELF_PURCHASED: 3
};

export const playDeviceProfiles = [
  { code: "STUDY_PC", label: "书房 · 9600XT", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "STUDY_PS5", label: "书房 · PS5", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "STUDY_NS2", label: "书房 · NS2", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "BEDROOM_5080", label: "卧室 · 5080／串流", scenario: "FIXED" as const, hdr: true, stream: true },
  { code: "BEDROOM_NS2", label: "卧室 · NS2", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "COMPANY_STREAM", label: "公司 · 串流", scenario: "FIXED" as const, hdr: true, stream: true },
  { code: "COMPANY_GPD", label: "公司 · GPD", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "COMPANY_NS2", label: "公司 · NS2", scenario: "FIXED" as const, hdr: true, stream: false },
  { code: "COMMUTE_GPD", label: "通勤 · GPD", scenario: "COMMUTE" as const, hdr: false, stream: false },
  { code: "COMMUTE_NS2", label: "通勤 · NS2", scenario: "COMMUTE" as const, hdr: true, stream: false }
] as const;

export function acquisitionRank(channel: AcquisitionChannel | null) {
  return channel === null ? 99 : acquisitionChannelRank[channel];
}

export type PlatformScenarioRule = "COMMUTE" | "FIXED" | "BOTH" | "EXPLICIT";

function normalizedPlatform(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

export function platformScenarioRule(platform: string | null, source?: string | null): PlatformScenarioRule {
  const sourceIdentity = normalizedPlatform(source);
  const platformIdentity = normalizedPlatform(platform);
  if (sourceIdentity.includes("STEAM")) return "BOTH";
  if (sourceIdentity.includes("PLAYSTATION")) return "FIXED";
  if (sourceIdentity.includes("NINTENDO")) return "COMMUTE";
  if (platformIdentity.includes("PLAYSTATION") || platformIdentity.includes("PS4") || platformIdentity.includes("PS5")) return "FIXED";
  if (platformIdentity.includes("NINTENDO") || platformIdentity.includes("SWITCH")) return "COMMUTE";
  if (platformIdentity.includes("STEAM")) return "BOTH";
  return "EXPLICIT";
}

/** 心愿入手直达“接下来玩”时的场景推断：Nintendo Switch 系 → 通勤，其余（含 Steam 双场景）→ 固定。用户仍可拖拽调整。 */
export function defaultScenarioForPlatform(platform: string | null, source?: string | null): PlayScenario {
  return platformScenarioRule(platform, source) === "COMMUTE" ? "COMMUTE" : "FIXED";
}

export function acquisitionSupportsScenario(acquisition: {
  platform: string | null;
  source?: string | null;
  offlineCapable: boolean | null;
  manuallyClassified?: boolean;
}, scenario: PlayScenario) {
  if (scenario === "FIXED") return true;
  const rule = platformScenarioRule(acquisition.platform, acquisition.source);
  if (rule === "FIXED") return false;
  if (acquisition.manuallyClassified) return acquisition.offlineCapable === true;
  if (rule === "COMMUTE" || rule === "BOTH") return true;
  return acquisition.offlineCapable === true;
}

export function estimateMinutesForGoal(game: {
  estimatedHastilyMinutes: number | null;
  estimatedNormallyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
}, goal: CompletionGoal) {
  if (goal === "MAIN") return game.estimatedHastilyMinutes;
  if (goal === "COMPLETE") return game.estimatedCompletelyMinutes;
  return game.estimatedNormallyMinutes;
}

export function remainingMinutesForGoal(game: {
  estimatedHastilyMinutes: number | null;
  estimatedNormallyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
  totalPlaytimeMinutes: number;
  progressPercent: number | null;
}, goal: CompletionGoal) {
  const estimate = estimateMinutesForGoal(game, goal);
  if (estimate === null) return null;
  if (game.progressPercent !== null && game.progressPercent > 0) {
    return Math.max(0, Math.round(estimate * (100 - game.progressPercent) / 100));
  }
  return Math.max(0, estimate - game.totalPlaytimeMinutes);
}

export type PlannerAcquisition = {
  id: string;
  source: string;
  channel: AcquisitionChannel | null;
  platform: string | null;
  availability: AcquisitionAvailability;
  offlineCapable: boolean | null;
  manuallyClassified: boolean;
  commuteEligible: boolean;
  fixedEligible: boolean;
  isOwned: boolean;
  version: number;
  label: string;
};

export type PlannerGame = {
  id: string;
  nameZh: string;
  nameEn: string | null;
  platform: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  notes: string | null;
  statuses: GameStatus[];
  version: number;
  progressPercent: number | null;
  playtimeMinutesManual: number | null;
  totalPlaytimeMinutes: number;
  estimatedHastilyMinutes: number | null;
  estimatedNormallyMinutes: number | null;
  estimatedCompletelyMinutes: number | null;
  communityRating: number | null;
  criticRating: number | null;
  lastPlayedAt: string | null;
  acquisitions: PlannerAcquisition[];
};

export type PlannerPlan = {
  id: string;
  gameId: string;
  scenario: PlayScenario;
  state: PlayQueueState;
  acquisitionId: string | null;
  preferredDevice: string | null;
  completionGoal: CompletionGoal;
  queueOrder: number | null;
  version: number;
  channel: AcquisitionChannel | null;
  remainingMinutes: number | null;
  expectedWeeks: number | null;
  recommendationScore: number;
  game: PlannerGame;
};

export type PlannerScenario = {
  scenario: PlayScenario;
  weeklyBudgetMinutes: number;
  current: PlannerPlan | null;
  queue: PlannerPlan[];
};

export type PlayPlannerData = {
  generatedAt: string;
  scenarios: Record<PlayScenario, PlannerScenario>;
  nextQueue: PlannerPlan[];
  candidates: PlannerGame[];
  counts: {
    activeDistinct: number;
    queued: number;
    missingChannel: number;
    missingHltb: number;
  };
};
