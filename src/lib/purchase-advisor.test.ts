import { describe, expect, it } from "vitest";
import {
  dualsenseProfileMatrix,
  unknownDualsenseProfile,
  type DualsenseEnvironment,
  type DualsenseFeatureLevel,
  type DualsenseProfile,
  type DualsenseProfileMatrix,
  type RayTracingProfile
} from "@/lib/game-hardware";
import {
  advisePurchase,
  defaultHardwareProfile,
  parseHardwareProfile,
  normalizeAdvisorPlatform,
  type HardwareProfile
} from "@/lib/purchase-advisor";

const noRayTracing: RayTracingProfile = { level: "NONE", notes: null };
const dimensions = ["adaptiveTriggers", "hapticFeedback", "controllerSpeaker", "touchpad", "controllerMic"] as const;

function profile(
  environment: DualsenseEnvironment,
  level: DualsenseFeatureLevel,
  overrides: Partial<Omit<DualsenseProfile, "environment">> = {}
): DualsenseProfile {
  return {
    ...unknownDualsenseProfile(environment),
    ...Object.fromEntries(dimensions.map((dimension) => [dimension, level])),
    ...overrides,
    environment
  } as DualsenseProfile;
}

const unknownProfiles = dualsenseProfileMatrix([]);
const richFirstParty: DualsenseProfileMatrix = dualsenseProfileMatrix([
  profile("PS5_CONSOLE", "RICH"),
  profile("PC_USB", "UNKNOWN", { adaptiveTriggers: "RICH", hapticFeedback: "RICH" }),
  profile("PC_BLUETOOTH", "NONE")
]);
const flatProfiles: DualsenseProfileMatrix = dualsenseProfileMatrix([
  profile("PS5_CONSOLE", "NONE"),
  profile("PC_USB", "NONE"),
  profile("PC_BLUETOOTH", "NONE")
]);

function advise(overrides: {
  dualsenseProfiles?: DualsenseProfileMatrix;
  rayTracing?: RayTracingProfile;
  platforms?: string[];
  zeroCostChannels?: ("SUBSCRIPTION" | "FAMILY_SHARED" | "PHYSICAL" | "SELF_PURCHASED")[];
  hardware?: HardwareProfile;
}) {
  return advisePurchase({
    dualsenseProfiles: overrides.dualsenseProfiles ?? unknownProfiles,
    rayTracing: overrides.rayTracing ?? noRayTracing,
    platforms: overrides.platforms ?? ["PLAYSTATION", "STEAM"],
    zeroCostChannels: overrides.zeroCostChannels ?? [],
    hardware: overrides.hardware ?? defaultHardwareProfile
  });
}

describe("purchase advisor rule a: environment-scoped DualSense", () => {
  it("recommends PS5 and reports PC USB/Bluetooth separately", () => {
    const advice = advise({ dualsenseProfiles: richFirstParty });
    expect(advice.mode).toBe("SINGLE");
    expect(advice.suggestions[0].platform).toBe("PS5");
    expect(advice.suggestions[0].reasons.join()).toContain("DualSense 深度适配");
    expect(advice.suggestions[0].cautions.join()).toContain("PC · USB 有线");
    expect(advice.suggestions[0].cautions.join()).toContain("PC · 蓝牙");
  });

  it("keeps a Bluetooth exception attached only to Bluetooth", () => {
    const profiles = dualsenseProfileMatrix([
      richFirstParty.PS5_CONSOLE,
      richFirstParty.PC_USB,
      profile("PC_BLUETOOTH", "UNKNOWN", {
        adaptiveTriggers: "BASIC",
        notes: "蓝牙可触发基础扳机阻尼。"
      })
    ]);
    const caution = advise({ dualsenseProfiles: profiles }).suggestions[0].cautions.join();
    expect(caution).toContain("PC · 蓝牙：🔫自适应扳机");
    expect(caution).toContain("蓝牙可触发基础扳机阻尼");
  });

  it("does not infer Bluetooth capability from a rich USB profile", () => {
    const advice = advise({ dualsenseProfiles: richFirstParty });
    const caution = advice.suggestions[0].cautions.join();
    expect(caution).toContain("PC · USB 有线：🔫自适应扳机、📳高级触觉反馈");
    expect(caution).toContain("PC · 蓝牙：无专属 DualSense 特性");
  });
});

describe("purchase advisor rule b: path tracing", () => {
  it("recommends PC/Steam for path tracing on a high-end RTX build", () => {
    const advice = advise({
      dualsenseProfiles: flatProfiles,
      rayTracing: { level: "RT_FULL_PATH_TRACING", notes: "路径光追为 PC 独占" }
    });
    expect(advice.mode).toBe("SINGLE");
    expect(advice.suggestions[0].platform).toBe("PC");
    expect(advice.suggestions[0].reasons.join()).toContain("RTX 5090D");
  });

  it("does not trigger without a high-end RTX profile", () => {
    const advice = advise({
      dualsenseProfiles: flatProfiles,
      rayTracing: { level: "RT_FULL_PATH_TRACING", notes: null },
      hardware: { ...defaultHardwareProfile, pcGpuTier: "MAINSTREAM" }
    });
    expect(advice.mode).toBe("NONE");
  });

  it("does not trigger for basic ray tracing", () => {
    expect(advise({ dualsenseProfiles: flatProfiles, rayTracing: { level: "RT_BASIC", notes: null } }).mode).toBe("NONE");
  });
});

describe("purchase advisor rule c: conflicts produce a dual comparison", () => {
  it("outputs PS5 vs PC options and keeps connection-specific cautions", () => {
    const cyberpunk = dualsenseProfileMatrix([
      profile("PS5_CONSOLE", "NONE", { controllerSpeaker: "RICH" }),
      profile("PC_USB", "UNKNOWN", { adaptiveTriggers: "BASIC", hapticFeedback: "BASIC" }),
      profile("PC_BLUETOOTH", "NONE")
    ]);
    const advice = advise({
      dualsenseProfiles: cyberpunk,
      rayTracing: { level: "RT_FULL_PATH_TRACING", notes: "路径光追为 PC 独占" }
    });
    expect(advice.mode).toBe("DUAL_COMPARE");
    expect(advice.suggestions.map((suggestion) => suggestion.platform)).toEqual(["PS5", "PC"]);
    expect(advice.suggestions[1].cautions.join()).toContain("PC · USB 有线");
    expect(advice.suggestions[1].cautions.join()).toContain("PC · 蓝牙");
  });
});

describe("purchase advisor rule d: zero-cost channels", () => {
  it("prioritizes zero-cost channels when no feature difference is significant", () => {
    const advice = advise({ dualsenseProfiles: flatProfiles, zeroCostChannels: ["SUBSCRIPTION"] });
    expect(advice.mode).toBe("NONE");
    expect(advice.summary).toContain("会免");
  });

  it("keeps feature recommendations and lists free channels as secondary", () => {
    const advice = advise({ dualsenseProfiles: richFirstParty, zeroCostChannels: ["FAMILY_SHARED"] });
    expect(advice.suggestions[0].platform).toBe("PS5");
    expect(advice.notes.join()).toContain("家庭共享");
  });

  it("ignores paid channels for the zero-cost rule", () => {
    const advice = advise({ dualsenseProfiles: flatProfiles, zeroCostChannels: ["PHYSICAL", "SELF_PURCHASED"] });
    expect(advice.notes.join()).not.toContain("零成本渠道优先");
  });
});

describe("purchase advisor edge cases", () => {
  it("asks for profile data when all environments are unknown", () => {
    const advice = advise({ rayTracing: { level: "UNKNOWN", notes: null } });
    expect(advice.notes.join()).toContain("档案未填写");
  });

  it("falls back to PC with both connection summaries when PS5 is unavailable", () => {
    const advice = advise({
      dualsenseProfiles: richFirstParty,
      hardware: { ...defaultHardwareProfile, ownsPs5: false }
    });
    expect(advice.suggestions[0].platform).toBe("PC");
    expect(advice.suggestions[0].cautions.join()).toContain("PC · USB 有线");
    expect(advice.suggestions[0].cautions.join()).toContain("PC · 蓝牙");
  });

  it("normalizes platform strings", () => {
    expect(normalizeAdvisorPlatform("PLAYSTATION")).toBe("PS5");
    expect(normalizeAdvisorPlatform("PS4")).toBe("PS5");
    expect(normalizeAdvisorPlatform("NINTENDO_SWITCH_2")).toBe("SWITCH");
    expect(normalizeAdvisorPlatform("STEAM")).toBe("PC");
    expect(normalizeAdvisorPlatform("IOS")).toBeNull();
  });

  it("parses hardware profiles defensively", () => {
    expect(parseHardwareProfile(null)).toEqual(defaultHardwareProfile);
    expect(parseHardwareProfile({ ownsPs5: false, pcGpuTier: "BOGUS" })).toEqual({
      ...defaultHardwareProfile,
      ownsPs5: false
    });
  });
});
