import { describe, expect, it } from "vitest";
import {
  compareUnifiedNextQueue,
  completionControl,
  deriveActivityState,
  derivePurchaseState,
  displayStatuses,
  isWishlisted,
  providerForPlatform,
  recommendedChannel,
  visibleActivityState,
  type UnifiedQueueEntry
} from "./game-state-engine";

describe("game state engine · completion", () => {
  it("derives quick completion action from the COMPLETED fact", () => {
    expect(completionControl(["PLAYING"]).action).toBe("COMPLETE");
    expect(completionControl(["PLAYING", "COMPLETED"]).action).toBe("UNCOMPLETE");
    expect(completionControl(["COMPLETED"]).stateLabel).toBe("已通关");
  });
});

describe("game state engine · wishlist membership", () => {
  it("treats TO_BUY and legacy WISHLIST as the same concept", () => {
    expect(isWishlisted(["TO_BUY"])).toBe(true);
    expect(isWishlisted(["WISHLIST"])).toBe(true);
    expect(isWishlisted(["BACKLOG", "PLAYING"])).toBe(false);
  });
});

describe("game state engine · display statuses", () => {
  it("hides PLAYED when COMPLETED is present", () => {
    expect(displayStatuses(["PLAYED", "COMPLETED"])).toEqual(["COMPLETED"]);
    expect(displayStatuses(["PLAYED"])).toEqual(["PLAYED"]);
    expect(displayStatuses(["BACKLOG", "COMPLETED"])).toEqual(["BACKLOG", "COMPLETED"]);
  });
});

describe("game state engine · activity state", () => {
  const base = {
    statuses: [] as never[],
    totalPlaytimeMinutes: 120,
    lastPlayedAt: null,
    playtimeLastChangedAt: null
  };

  it("prefers explicit statuses over inferred activity", () => {
    expect(deriveActivityState({ ...base, statuses: ["COMPLETED"] as never })).toBe("COMPLETED_CONFIRMED");
    expect(deriveActivityState({ ...base, statuses: ["PAUSED"] as never })).toBe("PAUSED");
  });

  it("applies the 48 hour inactivity rule", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    expect(deriveActivityState({ ...base, playtimeLastChangedAt: "2026-07-20T12:00:00Z", now })).toBe("PLAYING");
    expect(deriveActivityState({ ...base, playtimeLastChangedAt: "2026-07-10T12:00:00Z", now })).toBe("COMPLETION_CANDIDATE");
  });

  it("hides activity chips that duplicate explicit statuses", () => {
    expect(visibleActivityState(["COMPLETED"], "COMPLETED_CONFIRMED")).toBeNull();
    expect(visibleActivityState([], "PLAYING")).toBe("PLAYING");
  });
});

describe("game state engine · purchase state", () => {
  it("ranks acquisition above ownership hints above TO_BUY", () => {
    expect(derivePurchaseState({ hasAcquisition: true, ownershipStatus: null, statuses: [] })).toBe("OWNED");
    expect(derivePurchaseState({ hasAcquisition: false, ownershipStatus: "FAMILY_SHARED", statuses: [] })).toBe("FAMILY_SHARED");
    expect(derivePurchaseState({ hasAcquisition: false, ownershipStatus: null, statuses: ["TO_BUY"] })).toBe("TO_BUY");
    expect(derivePurchaseState({ hasAcquisition: false, ownershipStatus: null, statuses: [] })).toBe("UNKNOWN");
  });
});

describe("game state engine · unified next queue ordering", () => {
  const entry = (overrides: Partial<UnifiedQueueEntry>): UnifiedQueueEntry => ({
    channel: null,
    queueOrder: null,
    scenario: "FIXED",
    game: { nameZh: "游戏" },
    ...overrides
  });

  it("sorts by channel rank first: subscription > family > physical > self purchased > untagged", () => {
    const list = [
      entry({ channel: "SELF_PURCHASED", game: { nameZh: "自购" } }),
      entry({ channel: null, game: { nameZh: "未标注" } }),
      entry({ channel: "SUBSCRIPTION", game: { nameZh: "会免" } }),
      entry({ channel: "PHYSICAL", game: { nameZh: "实体" } }),
      entry({ channel: "FAMILY_SHARED", game: { nameZh: "家庭" } })
    ].sort(compareUnifiedNextQueue);
    expect(list.map((item) => item.game.nameZh)).toEqual(["会免", "家庭", "实体", "自购", "未标注"]);
  });

  it("breaks ties by queue order, then scenario, then name", () => {
    const list = [
      entry({ channel: "SUBSCRIPTION", queueOrder: 2, game: { nameZh: "乙" } }),
      entry({ channel: "SUBSCRIPTION", queueOrder: 1, scenario: "FIXED", game: { nameZh: "丙" } }),
      entry({ channel: "SUBSCRIPTION", queueOrder: 1, scenario: "COMMUTE", game: { nameZh: "甲" } })
    ].sort(compareUnifiedNextQueue);
    expect(list.map((item) => item.game.nameZh)).toEqual(["甲", "丙", "乙"]);
  });
});

describe("game state engine · wishlist platform inference", () => {
  it("maps platform codes to providers with a single implementation", () => {
    expect(providerForPlatform("STEAM")).toBe("STEAM");
    expect(providerForPlatform("PS5")).toBe("PLAYSTATION");
    expect(providerForPlatform(" nintendo_switch_2 ")).toBe("NINTENDO");
  });

  it("recommends channels per provider habit", () => {
    expect(recommendedChannel("PLAYSTATION")).toBe("SUBSCRIPTION");
    expect(recommendedChannel("NINTENDO")).toBe("PHYSICAL");
    expect(recommendedChannel("STEAM")).toBe("SELF_PURCHASED");
  });
});
