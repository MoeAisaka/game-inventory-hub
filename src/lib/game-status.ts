export const gameStatusValues = [
  "BACKLOG",
  "PLAYING",
  "PLAYED",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
  "UNPLANNED",
  "UNRELEASED",
  "TO_BUY",
  "WISHLIST"
] as const;

export type GameStatus = (typeof gameStatusValues)[number];

export const persistedGameStatusValues = gameStatusValues.filter(
  (status): status is Exclude<GameStatus, "COMPLETED"> => status !== "COMPLETED"
);

export const legacyGameStatusValues = [
  "BACKLOG",
  "PLAYING",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
  "UNPLANNED"
] as const satisfies readonly GameStatus[];

export type LegacyGameStatus = (typeof legacyGameStatusValues)[number];

export const gameStatusLabels: Record<GameStatus, string> = {
  BACKLOG: "接下来玩",
  PLAYING: "游玩中",
  PLAYED: "已游玩",
  PAUSED: "暂停",
  COMPLETED: "已通关",
  ABANDONED: "弃坑",
  UNPLANNED: "无计划",
  UNRELEASED: "待发售",
  TO_BUY: "待购入／愿望单",
  WISHLIST: "待购入／愿望单（兼容）"
};

const legacyStatusSet = new Set<string>(legacyGameStatusValues);

export function uniqueGameStatuses(values: readonly GameStatus[]) {
  return gameStatusValues.filter((status) => values.includes(status));
}

export function persistedGameStatuses(values: readonly GameStatus[]) {
  return persistedGameStatusValues.filter((status) => values.includes(status));
}

export function statusesWithCompletion(values: readonly GameStatus[], isCompleted: boolean) {
  return uniqueGameStatuses([
    ...values.filter((status) => status !== "COMPLETED"),
    ...(isCompleted ? ["COMPLETED" as const] : [])
  ]);
}

export function legacyStatusFor(values: readonly GameStatus[]): LegacyGameStatus | null {
  const unique = uniqueGameStatuses(values);
  return unique.find((status): status is LegacyGameStatus => status !== "COMPLETED" && legacyStatusSet.has(status))
    ?? (unique.includes("COMPLETED") ? "COMPLETED" : null);
}
