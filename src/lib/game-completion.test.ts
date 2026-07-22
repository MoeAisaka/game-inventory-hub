import { describe, expect, it } from "vitest";
import { completionControl } from "./game-completion";

describe("completionControl", () => {
  it("为未通关游戏提供标记通关动作", () => {
    expect(completionControl(["PLAYING"])).toEqual({
      completed: false,
      action: "COMPLETE",
      label: "标记通关",
      stateLabel: "未通关"
    });
  });

  it("为已通关游戏提供撤销通关动作", () => {
    expect(completionControl(["PLAYING", "COMPLETED"])).toEqual({
      completed: true,
      action: "UNCOMPLETE",
      label: "撤销通关",
      stateLabel: "已通关"
    });
  });
});
