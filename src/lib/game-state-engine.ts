/**
 * 游戏状态派生引擎（V0.32.0 需求四 B）。
 *
 * 记录状态（statuses 多值词表）、游玩状态（activityState）、购入状态（purchaseState）、
 * 心愿判定与"接下来玩"统一队列排序等派生规则全部收敛在本模块，
 * 今日页 / 游戏库 / 心愿单与服务端 home、games 服务一律从这里取派生结果。
 *
 * 词表本身（状态取值与文案）仍由 `game-status.ts` / `play-planning.ts` 承载；
 * `game-completion.ts` 与 `game-insights.ts` 保留为兼容再导出层，旧 import 路径不破坏。
 */
import type { GameStatus } from "@/lib/game-status";
import { acquisitionRank, type AcquisitionChannel, type PlayScenario } from "@/lib/play-planning";

/* ------------------------------------------------------------------ */
/* 通关事实（原 game-completion.ts）                                     */
/* ------------------------------------------------------------------ */

export type CompletionQuickAction = "COMPLETE" | "UNCOMPLETE";

/** COMPLETED 是独立事实位：由它派生快捷按钮的动作与文案。 */
export function completionControl(statuses: readonly GameStatus[]) {
  const completed = statuses.includes("COMPLETED");
  return {
    completed,
    action: (completed ? "UNCOMPLETE" : "COMPLETE") as CompletionQuickAction,
    label: completed ? "撤销通关" : "标记通关",
    stateLabel: completed ? "已通关" : "未通关"
  };
}

/* ------------------------------------------------------------------ */
/* 游玩活动状态与购入状态（原 game-insights.ts）                          */
/* ------------------------------------------------------------------ */

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
  COMPLETION_CANDIDATE: "已游玩",
  COMPLETED_CONFIRMED: "已通关",
  PAUSED: "已暂停",
  ABANDONED: "已放弃"
};

const activityStateStatusEquivalent: Partial<Record<ActivityState, GameStatus>> = {
  PLAYING: "PLAYING",
  COMPLETION_CANDIDATE: "PLAYED",
  COMPLETED_CONFIRMED: "COMPLETED",
  PAUSED: "PAUSED",
  ABANDONED: "ABANDONED"
};

/** 活动状态与显式记录状态语义重复时不再重复展示（避免同义双徽标）。 */
export function visibleActivityState(statuses: readonly GameStatus[], activityState: ActivityState) {
  const equivalent = activityStateStatusEquivalent[activityState];
  return equivalent && statuses.includes(equivalent) ? null : activityState;
}

/**
 * 游玩活动状态派生：显式状态优先（COMPLETED > PLAYED > ABANDONED > PAUSED），
 * 否则按游玩时长与最近活跃时间推断——48 小时内活跃视为 PLAYING，超时归为"已游玩"候选。
 */
export function deriveActivityState(input: {
  statuses: GameStatus[];
  totalPlaytimeMinutes: number;
  lastPlayedAt: Date | string | null;
  playtimeLastChangedAt: Date | string | null;
  now?: Date;
  inactivityHours?: number;
}): ActivityState {
  if (input.statuses.includes("COMPLETED")) return "COMPLETED_CONFIRMED";
  if (input.statuses.includes("PLAYED")) return "COMPLETION_CANDIDATE";
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

export type PurchaseState = "OWNED" | "FAMILY_SHARED" | "TO_BUY" | "UNKNOWN";

export const purchaseStateLabels: Record<PurchaseState, string> = {
  OWNED: "已购入",
  FAMILY_SHARED: "家庭共享",
  TO_BUY: "待购入",
  UNKNOWN: "未登记"
};

/** 购入状态派生：入库记录 / 显式归属 > 家庭共享 > 待购入 > 未登记。 */
export function derivePurchaseState(input: {
  hasAcquisition: boolean;
  ownershipStatus: string | null;
  statuses: GameStatus[];
}): PurchaseState {
  if (input.hasAcquisition || input.ownershipStatus === "OWNED") return "OWNED";
  if (input.ownershipStatus === "FAMILY_SHARED") return "FAMILY_SHARED";
  if (input.statuses.includes("TO_BUY")) return "TO_BUY";
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* 心愿判定与展示状态（原游戏库页面内联计算）                              */
/* ------------------------------------------------------------------ */

/** TO_BUY 与历史 WISHLIST 状态视为同一"待购入／愿望单"概念。 */
export function isWishlisted(statuses: readonly GameStatus[]) {
  return statuses.includes("WISHLIST") || statuses.includes("TO_BUY");
}

/** 列表展示状态：已通关时不再重复展示"已游玩"（COMPLETED 蕴含 PLAYED）。 */
export function displayStatuses(statuses: readonly GameStatus[]): GameStatus[] {
  return statuses.filter((status) => !(status === "PLAYED" && statuses.includes("COMPLETED")));
}

/* ------------------------------------------------------------------ */
/* "接下来玩"统一队列排序（原 server/services/home.ts 内联比较器）          */
/* ------------------------------------------------------------------ */

export type UnifiedQueueEntry = {
  channel: AcquisitionChannel | null;
  queueOrder: number | null;
  scenario: PlayScenario;
  game: { nameZh: string };
};

/**
 * 今日页跨场景合并"接下来玩"的统一口径：
 * 渠道（会免 > 家庭 > 实体 > 自购 > 未标注）> 队列序号 > 场景 > 中文名。
 */
export function compareUnifiedNextQueue(left: UnifiedQueueEntry, right: UnifiedQueueEntry) {
  return acquisitionRank(left.channel) - acquisitionRank(right.channel)
    || (left.queueOrder ?? 10_000) - (right.queueOrder ?? 10_000)
    || left.scenario.localeCompare(right.scenario)
    || left.game.nameZh.localeCompare(right.game.nameZh, "zh-CN");
}

/* ------------------------------------------------------------------ */
/* 心愿平台 → 提供方 / 推荐渠道（原客户端与服务端各一份的口径统一）          */
/* ------------------------------------------------------------------ */

export type WishlistProvider = "STEAM" | "PLAYSTATION" | "NINTENDO";

/** 平台代号推断心愿提供方；与服务端 acquire 校验共用同一实现。 */
export function providerForPlatform(platform: string): WishlistProvider {
  const value = platform.trim().toUpperCase();
  if (value.includes("PLAYSTATION") || value === "PS5" || value === "PS4") return "PLAYSTATION";
  if (value.includes("NINTENDO") || value.includes("SWITCH")) return "NINTENDO";
  return "STEAM";
}

/** 入手渠道推荐：PS 会免优先、任天堂实体优先、Steam 自购优先。 */
export function recommendedChannel(provider: WishlistProvider): AcquisitionChannel {
  if (provider === "PLAYSTATION") return "SUBSCRIPTION";
  if (provider === "NINTENDO") return "PHYSICAL";
  return "SELF_PURCHASED";
}
