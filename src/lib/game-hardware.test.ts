import { describe, expect, it } from "vitest";
import { dualsenseEnvironment, dualsenseFeatureLevel, gameMetadataField, pcWiredRequirement, rayTracingLevel } from "@/server/db/schema";
import {
  dualsenseDimensions,
  dualsenseEnvironmentLabels,
  dualsenseEnvironmentValues,
  dualsenseFeatureLevelLabels,
  dualsenseFeatureLevelValues,
  dualsenseProfileFilled,
  dualsenseProfileMatrix,
  dualsenseProfilesFilled,
  pcWiredRequirementLabels,
  pcWiredRequirementValues,
  rayTracingLevelLabels,
  rayTracingLevelValues,
  richDualsenseDimensions,
  unknownDualsenseProfile
} from "@/lib/game-hardware";

describe("game hardware vocabulary", () => {
  it("matches the database enums exactly", () => {
    expect(dualsenseFeatureLevel.enumValues).toEqual([...dualsenseFeatureLevelValues]);
    expect(dualsenseEnvironment.enumValues).toEqual([...dualsenseEnvironmentValues]);
    expect(pcWiredRequirement.enumValues).toEqual([...pcWiredRequirementValues]);
    expect(rayTracingLevel.enumValues).toEqual([...rayTracingLevelValues]);
  });

  it("registers profile lock fields in the metadata lock enum", () => {
    expect(gameMetadataField.enumValues).toContain("DUALSENSE_PROFILE");
    expect(gameMetadataField.enumValues).toContain("RAY_TRACING_PROFILE");
  });

  it("has Chinese-facing labels for every level", () => {
    for (const level of dualsenseFeatureLevelValues) expect(dualsenseFeatureLevelLabels[level]).toBeTruthy();
    for (const environment of dualsenseEnvironmentValues) expect(dualsenseEnvironmentLabels[environment]).toBeTruthy();
    for (const value of pcWiredRequirementValues) expect(pcWiredRequirementLabels[value]).toBeTruthy();
    for (const level of rayTracingLevelValues) expect(rayTracingLevelLabels[level]).toBeTruthy();
  });

  it("defines exactly five DualSense dimensions with the contract emoji", () => {
    expect(dualsenseDimensions.map((dimension) => dimension.emoji)).toEqual(["🔫", "📳", "🔊", "👋", "🎤"]);
    expect(new Set(dualsenseDimensions.map((dimension) => dimension.legacyGameField)).size).toBe(5);
  });

  it("extracts rich dimensions and detects unfilled environment matrices", () => {
    const unknown = unknownDualsenseProfile("PS5_CONSOLE");
    expect(richDualsenseDimensions(unknown)).toEqual([]);
    expect(dualsenseProfileFilled(unknown)).toBe(false);
    const partiallyFilled = { ...unknown, controllerSpeaker: "RICH" as const };
    expect(dualsenseProfileFilled(partiallyFilled)).toBe(true);
    expect(richDualsenseDimensions(partiallyFilled).map((dimension) => dimension.key)).toEqual(["controllerSpeaker"]);
    const matrix = dualsenseProfileMatrix([partiallyFilled]);
    expect(matrix.PS5_CONSOLE.controllerSpeaker).toBe("RICH");
    expect(matrix.PC_USB.environment).toBe("PC_USB");
    expect(dualsenseProfilesFilled(matrix)).toBe(true);
  });
});
