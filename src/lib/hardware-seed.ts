import { z } from "zod";
import {
  dualsenseEnvironmentValues,
  dualsenseFeatureLevelValues,
  rayTracingLevelValues
} from "@/lib/game-hardware";

const dualsenseSeedProfileSchema = z.object({
  environment: z.enum(dualsenseEnvironmentValues),
  adaptiveTriggers: z.enum(dualsenseFeatureLevelValues),
  hapticFeedback: z.enum(dualsenseFeatureLevelValues),
  controllerSpeaker: z.enum(dualsenseFeatureLevelValues),
  touchpad: z.enum(dualsenseFeatureLevelValues),
  controllerMic: z.enum(dualsenseFeatureLevelValues),
  notes: z.string().trim().min(1).max(2000).nullable()
});

const dualsenseSeedProfilesSchema = z.array(dualsenseSeedProfileSchema).length(dualsenseEnvironmentValues.length)
  .superRefine((profiles, context) => {
    const environments = new Set(profiles.map((profile) => profile.environment));
    if (environments.size !== dualsenseEnvironmentValues.length
      || dualsenseEnvironmentValues.some((environment) => !environments.has(environment))) {
      context.addIssue({ code: "custom", message: "每个种子必须且只能包含 PS5 主机、PC USB、PC 蓝牙三个环境" });
    }
  });

/** data/hardware-profiles-*.json 种子条目结构（人工编辑维护，含 source 备注字段）。 */
export const hardwareSeedEntrySchema = z.object({
  nameZh: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).default([]),
  dualsense: z.object({
    profiles: dualsenseSeedProfilesSchema
  }),
  rayTracing: z.object({
    level: z.enum(rayTracingLevelValues),
    notes: z.string().trim().min(1).max(2000).nullable()
  }),
  source: z.string().trim().min(1).max(500)
});

export const hardwareSeedSchema = z.array(hardwareSeedEntrySchema).min(1);

export type HardwareSeedEntry = z.infer<typeof hardwareSeedEntrySchema>;
