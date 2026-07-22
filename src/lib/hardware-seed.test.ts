import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hardwareSeedSchema } from "@/lib/hardware-seed";

const seed = hardwareSeedSchema.parse(
  JSON.parse(readFileSync(join(process.cwd(), "data/hardware-profiles-v0320.json"), "utf8"))
);

const requiredTitles = [
  "宇宙机器人",
  "蜘蛛侠：迈尔斯·莫拉莱斯",
  "战神：诸神黄昏",
  "最后生还者 第一部",
  "剑星",
  "赛博朋克2077",
  "死亡搁浅",
  "对马岛之魂",
  "艾尔登法环"
];

function profile(entry: (typeof seed)[number], environment: "PS5_CONSOLE" | "PC_USB" | "PC_BLUETOOTH") {
  return entry.dualsense.profiles.find((candidate) => candidate.environment === environment)!;
}

describe("hardware profile seed data", () => {
  it("covers every required title exactly once", () => {
    const names = seed.map((entry) => entry.nameZh);
    for (const title of requiredTitles) expect(names).toContain(title);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps an editorial source note on every entry", () => {
    for (const entry of seed) expect(entry.source).toContain("编辑维护");
  });

  it("marks Astro Bot as the all-RICH benchmark", () => {
    const astro = seed.find((entry) => entry.nameZh === "宇宙机器人")!;
    const ps5 = profile(astro, "PS5_CONSOLE");
    expect([
      ps5.adaptiveTriggers,
      ps5.hapticFeedback,
      ps5.controllerSpeaker,
      ps5.touchpad,
      ps5.controllerMic
    ]).toEqual(["RICH", "RICH", "RICH", "RICH", "RICH"]);
    expect(profile(astro, "PC_USB").adaptiveTriggers).toBe("NONE");
  });

  it("records the Miles Morales Bluetooth exception", () => {
    const miles = seed.find((entry) => entry.nameZh === "蜘蛛侠：迈尔斯·莫拉莱斯")!;
    expect(profile(miles, "PC_USB").hapticFeedback).toBe("RICH");
    expect(profile(miles, "PC_BLUETOOTH").adaptiveTriggers).toBe("BASIC");
    expect(profile(miles, "PC_BLUETOOTH").hapticFeedback).toBe("NONE");
    expect(profile(miles, "PC_BLUETOOTH").notes).toContain("蓝牙");
  });

  it("flags official wired requirements for Sony first-party PC ports", () => {
    for (const title of ["战神：诸神黄昏", "最后生还者 第一部"]) {
      const entry = seed.find((candidate) => candidate.nameZh === title)!;
      expect(profile(entry, "PC_USB").adaptiveTriggers).toBe("RICH");
      expect(profile(entry, "PC_USB").notes).toContain("官方");
      expect(profile(entry, "PC_BLUETOOTH").adaptiveTriggers).toBe("NONE");
    }
  });

  it("marks Cyberpunk 2077 as the path-tracing conflict case", () => {
    const cyberpunk = seed.find((entry) => entry.nameZh === "赛博朋克2077")!;
    expect(profile(cyberpunk, "PS5_CONSOLE").controllerSpeaker).toBe("RICH");
    expect(profile(cyberpunk, "PC_USB").adaptiveTriggers).toBe("BASIC");
    expect(profile(cyberpunk, "PC_BLUETOOTH").adaptiveTriggers).toBe("NONE");
    expect(cyberpunk.rayTracing.level).toBe("RT_FULL_PATH_TRACING");
    expect(cyberpunk.rayTracing.notes).toContain("PC 独占");
  });

  it("keeps Elden Ring free of DualSense specialization with basic ray tracing", () => {
    const eldenRing = seed.find((entry) => entry.nameZh === "艾尔登法环")!;
    for (const environment of ["PS5_CONSOLE", "PC_USB", "PC_BLUETOOTH"] as const) {
      const environmentProfile = profile(eldenRing, environment);
      expect([
        environmentProfile.adaptiveTriggers,
        environmentProfile.hapticFeedback,
        environmentProfile.controllerSpeaker,
        environmentProfile.touchpad,
        environmentProfile.controllerMic
      ]).toEqual(["NONE", "NONE", "NONE", "NONE", "NONE"]);
    }
    expect(eldenRing.rayTracing.level).toBe("RT_BASIC");
  });
});
