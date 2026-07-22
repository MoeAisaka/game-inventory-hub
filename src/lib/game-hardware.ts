export const dualsenseFeatureLevelValues = ["NONE", "BASIC", "RICH", "UNKNOWN"] as const;
export type DualsenseFeatureLevel = (typeof dualsenseFeatureLevelValues)[number];

export const dualsenseFeatureLevelLabels: Record<DualsenseFeatureLevel, string> = {
  NONE: "无",
  BASIC: "基础",
  RICH: "深度",
  UNKNOWN: "未知"
};

export const pcWiredRequirementValues = ["TRUE", "FALSE", "UNKNOWN"] as const;
export type PcWiredRequirement = (typeof pcWiredRequirementValues)[number];

export const pcWiredRequirementLabels: Record<PcWiredRequirement, string> = {
  TRUE: "PC 需 USB-C 有线",
  FALSE: "PC 无线可用",
  UNKNOWN: "未知"
};

export const dualsenseEnvironmentValues = ["PS5_CONSOLE", "PC_USB", "PC_BLUETOOTH"] as const;
export type DualsenseEnvironment = (typeof dualsenseEnvironmentValues)[number];

export const dualsenseEnvironmentLabels: Record<DualsenseEnvironment, string> = {
  PS5_CONSOLE: "PS5 主机",
  PC_USB: "PC · USB 有线",
  PC_BLUETOOTH: "PC · 蓝牙"
};

export const dualsenseEnvironmentHints: Record<DualsenseEnvironment, string> = {
  PS5_CONSOLE: "游戏在 PS5 主机上的原生 DualSense 特性",
  PC_USB: "PC 版通过 USB 数据线连接 DualSense 时的特性",
  PC_BLUETOOTH: "PC 版通过蓝牙连接 DualSense 时的特性"
};

export const rayTracingLevelValues = ["NONE", "RT_BASIC", "RT_FULL_PATH_TRACING", "UNKNOWN"] as const;
export type RayTracingLevel = (typeof rayTracingLevelValues)[number];

export const rayTracingLevelLabels: Record<RayTracingLevel, string> = {
  NONE: "无光追",
  RT_BASIC: "基础光追",
  RT_FULL_PATH_TRACING: "路径光追",
  UNKNOWN: "未知"
};

export const dualsenseDimensionKeys = [
  "adaptiveTriggers",
  "hapticFeedback",
  "controllerSpeaker",
  "touchpad",
  "controllerMic"
] as const;
export type DualsenseDimensionKey = (typeof dualsenseDimensionKeys)[number];

/** 五个 DualSense 特性维度：emoji 与中文标签用于详情页图标行与编辑表单。 */
export const dualsenseDimensions: Array<{
  key: DualsenseDimensionKey;
  /** 旧 games 表对应字段名，仅用于迁移和回滚兼容。 */
  legacyGameField: "dualsenseAdaptiveTriggers" | "dualsenseHapticFeedback" | "dualsenseControllerSpeaker" | "dualsenseTouchpad" | "dualsenseControllerMic";
  emoji: string;
  label: string;
  hint: string;
}> = [
  { key: "adaptiveTriggers", legacyGameField: "dualsenseAdaptiveTriggers", emoji: "🔫", label: "自适应扳机", hint: "扳机阻尼随场景变化，例如拉弓、扣扳机" },
  { key: "hapticFeedback", legacyGameField: "dualsenseHapticFeedback", emoji: "📳", label: "高级触觉反馈", hint: "高带宽触觉马达细腻震动，非普通转子震动" },
  { key: "controllerSpeaker", legacyGameField: "dualsenseControllerSpeaker", emoji: "🔊", label: "手柄扬声器", hint: "如剑星剑声、2077 通话声、死亡搁浅婴儿哭声" },
  { key: "touchpad", legacyGameField: "dualsenseTouchpad", emoji: "👋", label: "触摸板", hint: "如对马岛指引之风/收刀入鞘；多数游戏为分区点击唤菜单" },
  { key: "controllerMic", legacyGameField: "dualsenseControllerMic", emoji: "🎤", label: "手柄麦克风", hint: "对手柄吹气或语音互动" }
];

export type DualsenseProfile = {
  environment: DualsenseEnvironment;
  adaptiveTriggers: DualsenseFeatureLevel;
  hapticFeedback: DualsenseFeatureLevel;
  controllerSpeaker: DualsenseFeatureLevel;
  touchpad: DualsenseFeatureLevel;
  controllerMic: DualsenseFeatureLevel;
  notes: string | null;
};

export type DualsenseProfileMatrix = Record<DualsenseEnvironment, DualsenseProfile>;

export type RayTracingProfile = {
  level: RayTracingLevel;
  notes: string | null;
};

export function unknownDualsenseProfile(environment: DualsenseEnvironment): DualsenseProfile {
  return {
    environment,
    adaptiveTriggers: "UNKNOWN",
    hapticFeedback: "UNKNOWN",
    controllerSpeaker: "UNKNOWN",
    touchpad: "UNKNOWN",
    controllerMic: "UNKNOWN",
    notes: null
  };
}

export const unknownDualsenseProfiles: DualsenseProfileMatrix = {
  PS5_CONSOLE: unknownDualsenseProfile("PS5_CONSOLE"),
  PC_USB: unknownDualsenseProfile("PC_USB"),
  PC_BLUETOOTH: unknownDualsenseProfile("PC_BLUETOOTH")
};

/** @deprecated Kept for old API clients while the environment matrix rolls out. */
export const legacyUnknownDualsenseProfile = {
  adaptiveTriggers: "UNKNOWN",
  hapticFeedback: "UNKNOWN",
  controllerSpeaker: "UNKNOWN",
  touchpad: "UNKNOWN",
  controllerMic: "UNKNOWN",
  pcWiredRequired: "UNKNOWN",
  notes: null
} as const;

export type GameHardwareFields = {
  dualsenseAdaptiveTriggers: DualsenseFeatureLevel;
  dualsenseHapticFeedback: DualsenseFeatureLevel;
  dualsenseControllerSpeaker: DualsenseFeatureLevel;
  dualsenseTouchpad: DualsenseFeatureLevel;
  dualsenseControllerMic: DualsenseFeatureLevel;
  dualsenseNotes: string | null;
  pcWiredRequired: PcWiredRequirement;
  rayTracing: RayTracingLevel;
  rayTracingNotes: string | null;
};

export function legacyPs5ProfileFromGame(game: GameHardwareFields): DualsenseProfile {
  return {
    environment: "PS5_CONSOLE",
    adaptiveTriggers: game.dualsenseAdaptiveTriggers,
    hapticFeedback: game.dualsenseHapticFeedback,
    controllerSpeaker: game.dualsenseControllerSpeaker,
    touchpad: game.dualsenseTouchpad,
    controllerMic: game.dualsenseControllerMic,
    notes: game.dualsenseNotes
  };
}

export function dualsenseProfileMatrix(
  profiles: readonly DualsenseProfile[] | null | undefined,
  fallbackGame?: GameHardwareFields
): DualsenseProfileMatrix {
  const matrix: DualsenseProfileMatrix = {
    PS5_CONSOLE: fallbackGame ? legacyPs5ProfileFromGame(fallbackGame) : unknownDualsenseProfile("PS5_CONSOLE"),
    PC_USB: unknownDualsenseProfile("PC_USB"),
    PC_BLUETOOTH: unknownDualsenseProfile("PC_BLUETOOTH")
  };
  for (const profile of profiles ?? []) matrix[profile.environment] = profile;
  return matrix;
}

export function dualsenseProfilesFilled(profiles: DualsenseProfileMatrix) {
  return dualsenseEnvironmentValues.some((environment) => dualsenseProfileFilled(profiles[environment]));
}

export function rayTracingProfileFromGame(game: GameHardwareFields): RayTracingProfile {
  return { level: game.rayTracing, notes: game.rayTracingNotes };
}

/** 值为 RICH 的维度清单（按固定维度顺序）。 */
export function richDualsenseDimensions(profile: DualsenseProfile) {
  return dualsenseDimensions.filter((dimension) => profile[dimension.key] === "RICH");
}

export function dualsenseProfileFilled(profile: DualsenseProfile) {
  return dualsenseDimensions.some((dimension) => profile[dimension.key] !== "UNKNOWN");
}
