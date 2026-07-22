import type { AcquisitionChannel } from "@/lib/play-planning";
import {
  dualsenseDimensions,
  dualsenseEnvironmentLabels,
  dualsenseProfilesFilled,
  richDualsenseDimensions,
  type DualsenseProfileMatrix,
  type RayTracingProfile
} from "@/lib/game-hardware";

/**
 * 平台购买建议引擎（纯规则、可解释）。
 * 输入：DualSense 档案、光追档案、可用平台、既有零成本渠道（会免/家庭共享）、用户硬件档案。
 * 输出：建议平台列表（单建议或双选项对比）+ 中文理由 + 注意事项。
 */

export type PcGpuTier = "NONE" | "MAINSTREAM" | "HIGH_END_RTX";

export type HardwareProfile = {
  ownsPs5: boolean;
  ownsSwitch: boolean;
  pcGpuTier: PcGpuTier;
  pcGpuLabel: string | null;
};

/** 默认硬件档案：拥有 PS5、RTX 5090D 高端 PC、Switch。 */
export const defaultHardwareProfile: HardwareProfile = {
  ownsPs5: true,
  ownsSwitch: true,
  pcGpuTier: "HIGH_END_RTX",
  pcGpuLabel: "RTX 5090D"
};

const pcGpuTiers: readonly PcGpuTier[] = ["NONE", "MAINSTREAM", "HIGH_END_RTX"];

export function parseHardwareProfile(value: unknown): HardwareProfile {
  if (!value || typeof value !== "object") return defaultHardwareProfile;
  const record = value as Record<string, unknown>;
  return {
    ownsPs5: typeof record.ownsPs5 === "boolean" ? record.ownsPs5 : defaultHardwareProfile.ownsPs5,
    ownsSwitch: typeof record.ownsSwitch === "boolean" ? record.ownsSwitch : defaultHardwareProfile.ownsSwitch,
    pcGpuTier: pcGpuTiers.includes(record.pcGpuTier as PcGpuTier) ? record.pcGpuTier as PcGpuTier : defaultHardwareProfile.pcGpuTier,
    pcGpuLabel: typeof record.pcGpuLabel === "string" ? record.pcGpuLabel : defaultHardwareProfile.pcGpuLabel
  };
}

export type AdvisorPlatform = "PS5" | "PC" | "SWITCH";

export const advisorPlatformLabels: Record<AdvisorPlatform, string> = {
  PS5: "PS5",
  PC: "PC / Steam",
  SWITCH: "Switch"
};

/** 库内/心愿平台字符串（PLAYSTATION、STEAM、NINTENDO_SWITCH_2…）→ 建议引擎平台族。 */
export function normalizeAdvisorPlatform(platform: string | null | undefined): AdvisorPlatform | null {
  const value = (platform ?? "").trim().toUpperCase();
  if (!value) return null;
  if (value.includes("PLAYSTATION") || value === "PS5" || value === "PS4") return "PS5";
  if (value.includes("NINTENDO") || value.includes("SWITCH")) return "SWITCH";
  if (value.includes("STEAM") || value.includes("PC") || value === "XBOX_GAME_PASS") return "PC";
  return null;
}

export type PurchaseAdvisorInput = {
  dualsenseProfiles: DualsenseProfileMatrix;
  rayTracing: RayTracingProfile;
  /** 原始平台字符串（游戏平台、心愿平台变体等），引擎内部归一化。 */
  platforms: readonly (string | null | undefined)[];
  /** 当前可零成本入手的渠道（会免/家庭共享且状态可用）。 */
  zeroCostChannels: readonly AcquisitionChannel[];
  hardware: HardwareProfile;
};

export type PlatformSuggestion = {
  platform: AdvisorPlatform;
  title: string;
  reasons: string[];
  cautions: string[];
};

export type PurchaseAdvice = {
  mode: "SINGLE" | "DUAL_COMPARE" | "NONE";
  suggestions: PlatformSuggestion[];
  /** 全局提示（零成本渠道等次要考量）。 */
  notes: string[];
  /** 供心愿单卡片使用的一句话摘要。 */
  summary: string;
};

const zeroCostChannelLabels: Record<string, string> = {
  SUBSCRIPTION: "会免",
  FAMILY_SHARED: "家庭共享"
};

function zeroCostLabel(channels: readonly AcquisitionChannel[]) {
  const labels = [...new Set(channels.map((channel) => zeroCostChannelLabels[channel]).filter(Boolean))];
  return labels.join("／");
}

function supportedDimensions(profile: DualsenseProfileMatrix["PC_USB"]) {
  return dualsenseDimensions.filter((dimension) => profile[dimension.key] === "BASIC" || profile[dimension.key] === "RICH");
}

function environmentSummary(profile: DualsenseProfileMatrix["PC_USB"]) {
  const supported = supportedDimensions(profile);
  const allNone = dualsenseDimensions.every((dimension) => profile[dimension.key] === "NONE");
  if (supported.length) return `${dualsenseEnvironmentLabels[profile.environment]}：${supported.map((dimension) => `${dimension.emoji}${dimension.label}`).join("、")}`;
  if (allNone) return `${dualsenseEnvironmentLabels[profile.environment]}：无专属 DualSense 特性`;
  return `${dualsenseEnvironmentLabels[profile.environment]}：档案待核验`;
}

function pcCautionsFor(profiles: DualsenseProfileMatrix, dualsenseHit: boolean) {
  const cautions: string[] = [];
  if (dualsenseHit || dualsenseProfilesFilled(profiles)) {
    cautions.push(environmentSummary(profiles.PC_USB), environmentSummary(profiles.PC_BLUETOOTH));
  }
  for (const profile of [profiles.PC_USB, profiles.PC_BLUETOOTH]) {
    if (profile.notes) cautions.push(`${dualsenseEnvironmentLabels[profile.environment]}：${profile.notes}`);
  }
  return cautions;
}

export function advisePurchase(input: PurchaseAdvisorInput): PurchaseAdvice {
  const { dualsenseProfiles, rayTracing, hardware } = input;
  const ps5Profile = dualsenseProfiles.PS5_CONSOLE;
  const platformSet = new Set(input.platforms.map(normalizeAdvisorPlatform).filter((value): value is AdvisorPlatform => value !== null));
  const richDimensions = richDualsenseDimensions(ps5Profile);
  const dualsenseHit = richDimensions.length > 0 && hardware.ownsPs5;
  const pathTracingHit = rayTracing.level === "RT_FULL_PATH_TRACING" && hardware.pcGpuTier === "HIGH_END_RTX";
  const zeroCost = input.zeroCostChannels.filter((channel) => channel === "SUBSCRIPTION" || channel === "FAMILY_SHARED");
  const notes: string[] = [];

  const richSummary = richDimensions.map((dimension) => `${dimension.emoji}${dimension.label}`).join("、");
  const gpuLabel = hardware.pcGpuLabel ?? "高端 RTX";

  const ps5Suggestion = (): PlatformSuggestion => ({
    platform: "PS5",
    title: "PS5 版 · 手柄体验",
    reasons: [
      `DualSense 深度适配：${richSummary}`,
      ...(platformSet.has("PS5") ? [] : ["当前库内/心愿未记录 PS 版本，购买前请确认该平台在售"]),
      ...(richDimensions.length ? ["PS5 主机、PC USB 与 PC 蓝牙档案已分开评估，不以单一“需有线”标签替代"] : [])
    ],
    cautions: []
  });

  const pcSuggestion = (withRt: boolean): PlatformSuggestion => ({
    platform: "PC",
    title: withRt ? "PC / Steam 版 · 路径光追画质" : "PC / Steam 版",
    reasons: withRt
      ? [
        `支持路径光追（全景光线追踪），${gpuLabel} 可开启最高画质`,
        ...(rayTracing.notes ? [rayTracing.notes] : [])
      ]
      : [],
    cautions: pcCautionsFor(dualsenseProfiles, richDimensions.length > 0)
  });

  if (zeroCost.length && (dualsenseHit || pathTracingHit)) {
    notes.push(`次要考量：该作当前可通过${zeroCostLabel(zeroCost)}零成本入手，可先零成本体验再决定是否购买建议平台版本。`);
  }

  if (dualsenseHit && pathTracingHit) {
    return {
      mode: "DUAL_COMPARE",
      suggestions: [ps5Suggestion(), pcSuggestion(true)],
      notes,
      summary: "双选项对比：PS5 手柄体验 vs PC 路径光追画质"
    };
  }

  if (dualsenseHit) {
    const primary = ps5Suggestion();
    const pcCautions = pcCautionsFor(dualsenseProfiles, true);
    primary.cautions.push(`若考虑 PC 版：${pcCautions.join("；")}`);
    return {
      mode: "SINGLE",
      suggestions: [primary],
      notes,
      summary: `建议 PS5 版：${richSummary}`
    };
  }

  if (pathTracingHit) {
    return {
      mode: "SINGLE",
      suggestions: [pcSuggestion(true)],
      notes,
      summary: `建议 PC / Steam 版：路径光追＋${gpuLabel}`
    };
  }

  if (richDimensions.length > 0 && !hardware.ownsPs5) {
    return {
      mode: "SINGLE",
      suggestions: [pcSuggestion(false)],
      notes: [`该作有 DualSense 深度适配（${richSummary}），但硬件档案显示未拥有 PS5；如在 PC 游玩请注意手柄连接方式。`],
      summary: "未拥有 PS5：按 PC 连接方式核对 DualSense 特性"
    };
  }

  if (zeroCost.length) {
    return {
      mode: "NONE",
      suggestions: [],
      notes: [`零成本渠道优先：当前可通过${zeroCostLabel(zeroCost)}直接入手，无需额外购买。`],
      summary: `零成本渠道优先（${zeroCostLabel(zeroCost)}）`
    };
  }

  if (!dualsenseProfilesFilled(dualsenseProfiles) && rayTracing.level === "UNKNOWN") {
    return {
      mode: "NONE",
      suggestions: [],
      notes: ["硬件档案未填写：补全 DualSense 特性与光追档案后可生成平台购买建议。"],
      summary: "档案未填写，暂无平台建议"
    };
  }

  return {
    mode: "NONE",
    suggestions: [],
    notes: ["无显著平台差异：该作没有 DualSense 深度适配或路径光追命中，按价格与现有平台习惯选择即可。"],
    summary: "无显著平台差异，按价格与习惯选择"
  };
}
