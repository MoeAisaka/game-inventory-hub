export const gameStatusValues = [
  "BACKLOG",
  "PLAYING",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
  "UNPLANNED",
  "UNRELEASED",
  "TO_BUY"
] as const;

export type GameStatus = (typeof gameStatusValues)[number];

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
  BACKLOG: "待玩",
  PLAYING: "游玩中",
  PAUSED: "暂停",
  COMPLETED: "已通关",
  ABANDONED: "弃坑",
  UNPLANNED: "不计划",
  UNRELEASED: "待发售",
  TO_BUY: "待购入"
};

const legacyStatusSet = new Set<string>(legacyGameStatusValues);

export function uniqueGameStatuses(values: readonly GameStatus[]) {
  return gameStatusValues.filter((status) => values.includes(status));
}

export function legacyStatusFor(values: readonly GameStatus[]): LegacyGameStatus | null {
  return uniqueGameStatuses(values).find((status): status is LegacyGameStatus => legacyStatusSet.has(status)) ?? null;
}
