import { describe, expect, it } from "vitest";
import { gameStatusLabels } from "./game-status";

describe("game status product labels", () => {
  it("uses one user-facing next-play concept", () => {
    expect(gameStatusLabels.BACKLOG).toBe("接下来玩");
    expect(gameStatusLabels.UNPLANNED).toBe("无计划");
    expect(Object.values(gameStatusLabels)).not.toContain("待玩");
  });
});
