import { randomUUID } from "node:crypto";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  acquisitionAvailabilityValues,
  acquisitionChannelValues,
  acquisitionSupportsScenario,
  acquisitionRank,
  completionGoalValues,
  estimateMinutesForGoal,
  playScenarioValues,
  remainingMinutesForGoal,
  type PlannerAcquisition,
  type PlannerGame,
  type PlannerPlan,
  type PlayPlannerData,
  type PlayScenario
} from "@/lib/play-planning";
import { statusesWithCompletion, type GameStatus } from "@/lib/game-status";
import { db } from "@/server/db";
import {
  auditLogs,
  gameAcquisitions,
  gamePlayPlans,
  games,
  gameStatusAssignments,
  userPreferences
} from "@/server/db/schema";
import { reconcileWishlistForGames } from "@/server/services/game-wishlist";
import { lockPlayPlannerOwner, setLifecycleStatus } from "@/server/services/play-plan-lifecycle";

const nullablePlatform = z.string().trim().min(1).max(60).nullable();
const nullableDevice = z.string().trim().min(1).max(60).nullable();

export const playPlannerActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SET_ACQUISITION"),
    gameId: z.uuid(),
    acquisitionId: z.uuid().nullable().optional(),
    version: z.number().int().positive().optional(),
    channel: z.enum(acquisitionChannelValues),
    platform: nullablePlatform,
    availability: z.enum(acquisitionAvailabilityValues),
    offlineCapable: z.boolean()
  }).superRefine((value, context) => {
    if (value.acquisitionId && value.version === undefined) {
      context.addIssue({ code: "custom", path: ["version"], message: "修改渠道时需要版本号" });
    }
  }),
  z.object({
    action: z.literal("SET_PLAN"),
    gameId: z.uuid(),
    scenario: z.enum(playScenarioValues),
    state: z.enum(["QUEUED", "PLAYING"]),
    acquisitionId: z.uuid().nullable().optional(),
    preferredDevice: nullableDevice.optional(),
    completionGoal: z.enum(completionGoalValues).default("EXTRA"),
    queueOrder: z.number().int().min(1).max(9999).nullable().optional(),
    version: z.number().int().positive().optional(),
    replaceCurrent: z.boolean().default(false)
  }),
  z.object({
    action: z.literal("MOVE_PLAN"),
    gameId: z.uuid(),
    sourceScenario: z.enum(playScenarioValues),
    targetScenario: z.enum(playScenarioValues),
    targetState: z.enum(["QUEUED", "PLAYING"]),
    sourceVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive().optional(),
    acquisitionId: z.uuid().nullable().optional(),
    preferredDevice: nullableDevice.optional(),
    completionGoal: z.enum(completionGoalValues).default("EXTRA"),
    queueOrder: z.number().int().min(1).max(9999).nullable().optional(),
    replaceCurrent: z.boolean().default(false)
  }).refine((value) => value.sourceScenario !== value.targetScenario, {
    path: ["targetScenario"], message: "跨场景移动的目标必须不同"
  }),
  z.object({
    action: z.literal("REMOVE_PLAN"),
    gameId: z.uuid(),
    scenario: z.enum(playScenarioValues),
    version: z.number().int().positive()
  }),
  z.object({
    action: z.literal("SAVE_BUDGETS"),
    commuteWeeklyMinutes: z.number().int().min(30).max(10_080),
    fixedWeeklyMinutes: z.number().int().min(30).max(10_080)
  })
]);

export type PlayPlannerAction = z.infer<typeof playPlannerActionSchema>;

export class PlayPlannerError extends Error {
  constructor(public code: "GAME_NOT_FOUND" | "GAME_COMPLETED" | "GAME_ABANDONED" | "ACQUISITION_NOT_FOUND" | "ACQUISITION_REQUIRED" | "OFFLINE_REQUIRED" | "SCENARIO_OCCUPIED" | "CONFLICT", message: string) {
    super(message);
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function detailLabel(details: Record<string, unknown>, source: string) {
  return typeof details.label === "string" && details.label.trim() ? details.label.trim() : source;
}

function serializeAcquisition(row: typeof gameAcquisitions.$inferSelect): PlannerAcquisition {
  const manuallyClassified = row.details.manuallyClassified === true;
  const base = {
    platform: row.platform,
    source: row.source,
    offlineCapable: row.offlineCapable,
    manuallyClassified
  };
  return {
    id: row.id,
    source: row.source,
    channel: row.channel,
    platform: row.platform,
    availability: row.availability,
    offlineCapable: row.offlineCapable,
    manuallyClassified,
    commuteEligible: acquisitionSupportsScenario(base, "COMMUTE"),
    fixedEligible: acquisitionSupportsScenario(base, "FIXED"),
    isOwned: row.isOwned,
    version: row.version,
    label: detailLabel(row.details, row.source)
  };
}

function bestAcquisition(acquisitions: PlannerAcquisition[], scenario: PlayScenario) {
  return acquisitions.filter((item) => item.availability === "AVAILABLE"
      && (scenario === "COMMUTE" ? item.commuteEligible : item.fixedEligible))
    .sort((left, right) => acquisitionRank(left.channel) - acquisitionRank(right.channel)
      || Number(right.offlineCapable) - Number(left.offlineCapable)
      || left.label.localeCompare(right.label, "zh-CN"))[0] ?? null;
}

function plannerScore(game: PlannerGame, scenario: PlayScenario, remainingMinutes: number | null, weeklyBudgetMinutes: number) {
  let score = 0;
  const preferred = game.acquisitions.some((item) => item.availability === "AVAILABLE"
    && (scenario === "COMMUTE" ? item.commuteEligible : item.fixedEligible));
  if (preferred) score += 30;
  if (remainingMinutes !== null) {
    const weeks = remainingMinutes / Math.max(weeklyBudgetMinutes, 1);
    score += Math.max(0, 20 - Math.abs(weeks - 4) * 2);
  }
  score += Math.min(20, (game.communityRating ?? 50) / 5);
  if (game.lastPlayedAt) score += 10;
  if (game.progressPercent !== null && game.progressPercent > 0) score += Math.min(20, game.progressPercent / 5);
  return Math.round(score * 10) / 10;
}

function planSorter(left: PlannerPlan, right: PlannerPlan) {
  return acquisitionRank(left.channel) - acquisitionRank(right.channel)
    || (left.queueOrder ?? 10_000) - (right.queueOrder ?? 10_000)
    || right.recommendationScore - left.recommendationScore
    || (left.remainingMinutes ?? Number.MAX_SAFE_INTEGER) - (right.remainingMinutes ?? Number.MAX_SAFE_INTEGER)
    || left.game.nameZh.localeCompare(right.game.nameZh, "zh-CN");
}

export async function getPlayPlannerData(ownerUserId: string, now = new Date()): Promise<PlayPlannerData> {
  const [gameRows, statusRows, acquisitionRows, planRows, preferenceRows] = await Promise.all([
    db.select().from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select({ gameId: gameStatusAssignments.gameId, status: gameStatusAssignments.status })
      .from(gameStatusAssignments)
      .innerJoin(games, eq(games.id, gameStatusAssignments.gameId))
      .where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))),
    db.select().from(gameAcquisitions).where(eq(gameAcquisitions.ownerUserId, ownerUserId)),
    db.select().from(gamePlayPlans).where(eq(gamePlayPlans.ownerUserId, ownerUserId)),
    db.select({ value: userPreferences.value }).from(userPreferences).where(and(
      eq(userPreferences.ownerUserId, ownerUserId), eq(userPreferences.namespace, "play_planner")
    )).limit(1)
  ]);
  const rawPreferences = preferenceRows[0]?.value ?? {};
  const commuteWeeklyMinutes = typeof rawPreferences.commuteWeeklyMinutes === "number" ? rawPreferences.commuteWeeklyMinutes : 300;
  const fixedWeeklyMinutes = typeof rawPreferences.fixedWeeklyMinutes === "number" ? rawPreferences.fixedWeeklyMinutes : 600;
  const statusesByGame = new Map<string, GameStatus[]>();
  for (const row of statusRows) statusesByGame.set(row.gameId, [...(statusesByGame.get(row.gameId) ?? []), row.status]);
  const acquisitionsByGame = new Map<string, PlannerAcquisition[]>();
  for (const row of acquisitionRows) acquisitionsByGame.set(row.gameId, [...(acquisitionsByGame.get(row.gameId) ?? []), serializeAcquisition(row)]);
  const plannerGames = new Map<string, PlannerGame>();
  for (const game of gameRows) {
    const statuses = statusesWithCompletion(statusesByGame.get(game.id) ?? (game.playStatus ? [game.playStatus as GameStatus] : []), game.isCompleted);
    plannerGames.set(game.id, {
      id: game.id,
      nameZh: game.nameZh,
      nameEn: game.nameEn,
      platform: game.platform,
      coverUrl: game.coverUrl,
      releaseDate: game.releaseDate,
      notes: game.notes,
      statuses,
      version: game.version,
      progressPercent: game.progressPercent,
      playtimeMinutesManual: game.playtimeMinutesManual,
      totalPlaytimeMinutes: game.playtimeMinutesManual ?? game.playtimeMinutesSynced,
      estimatedHastilyMinutes: game.estimatedHastilyMinutes,
      estimatedNormallyMinutes: game.estimatedNormallyMinutes,
      estimatedCompletelyMinutes: game.estimatedCompletelyMinutes,
      communityRating: game.communityRating,
      criticRating: game.criticRating,
      lastPlayedAt: game.lastPlayedAt?.toISOString() ?? null,
      acquisitions: acquisitionsByGame.get(game.id) ?? []
    });
  }
  const scenarioBudgets: Record<PlayScenario, number> = { COMMUTE: commuteWeeklyMinutes, FIXED: fixedWeeklyMinutes };
  const serializedPlans = planRows.flatMap((plan): PlannerPlan[] => {
    const game = plannerGames.get(plan.gameId);
    // Defensive read-path guard for records created before terminal statuses
    // started atomically archiving plans. Stale rows stay invisible until
    // migration cleanup removes them.
    if (!game || game.statuses.includes("COMPLETED") || game.statuses.includes("ABANDONED")) return [];
    const selected = plan.acquisitionId ? game.acquisitions.find((item) => item.id === plan.acquisitionId) ?? null : null;
    const acquisition = selected && selected.availability === "AVAILABLE"
      ? selected
      : bestAcquisition(game.acquisitions, plan.scenario);
    const remainingMinutes = remainingMinutesForGoal(game, plan.completionGoal);
    const weeklyBudget = scenarioBudgets[plan.scenario];
    return [{
      id: plan.id,
      gameId: plan.gameId,
      scenario: plan.scenario,
      state: plan.state,
      acquisitionId: acquisition?.id ?? null,
      preferredDevice: plan.preferredDevice,
      completionGoal: plan.completionGoal,
      queueOrder: plan.queueOrder,
      version: plan.version,
      channel: acquisition?.channel ?? null,
      remainingMinutes,
      expectedWeeks: remainingMinutes === null ? null : Math.round(remainingMinutes / Math.max(weeklyBudget, 1) * 10) / 10,
      recommendationScore: plannerScore(game, plan.scenario, remainingMinutes, weeklyBudget),
      game
    }];
  });
  const nextQueue = serializedPlans.filter((plan) => plan.state === "QUEUED").sort(planSorter);
  const scenarios = Object.fromEntries(playScenarioValues.map((scenario) => {
    const plans = serializedPlans.filter((plan) => plan.scenario === scenario);
    return [scenario, {
      scenario,
      weeklyBudgetMinutes: scenarioBudgets[scenario],
      current: plans.find((plan) => plan.state === "PLAYING") ?? null,
      queue: nextQueue.filter((plan) => plan.scenario === scenario)
    }];
  })) as PlayPlannerData["scenarios"];
  const plannedIds = new Set(serializedPlans.map((plan) => plan.gameId));
  const candidateBase = [...plannerGames.values()].filter((game) => !plannedIds.has(game.id)
    && !game.statuses.includes("COMPLETED")
    && !game.statuses.includes("ABANDONED")
    && !game.statuses.includes("UNRELEASED")
    && !game.statuses.includes("TO_BUY")
    && !game.statuses.includes("WISHLIST"));
  const hasAvailableChannel = (game: PlannerGame) => game.acquisitions.some((item) =>
    item.channel !== null && item.availability === "AVAILABLE");
  const candidates = candidateBase.filter(hasAvailableChannel)
    .sort((left, right) => {
      const leftAcquisition = bestAcquisition(left.acquisitions, "FIXED");
      const rightAcquisition = bestAcquisition(right.acquisitions, "FIXED");
      return acquisitionRank(leftAcquisition?.channel ?? null) - acquisitionRank(rightAcquisition?.channel ?? null)
        || left.nameZh.localeCompare(right.nameZh, "zh-CN");
    });
  return {
    generatedAt: now.toISOString(),
    scenarios,
    nextQueue,
    candidates,
    counts: {
      activeDistinct: new Set(serializedPlans.filter((plan) => plan.state === "PLAYING").map((plan) => plan.gameId)).size,
      queued: nextQueue.length,
      // Games without a usable channel are data-hygiene work, not candidate
      // pool entries. Keep the count visible without mixing them into the pool.
      missingChannel: candidateBase.filter((game) => !hasAvailableChannel(game)).length,
      missingHltb: candidates.filter((game) => estimateMinutesForGoal(game, "EXTRA") === null).length
    }
  };
}

export async function nextPlanQueueOrder(
  transaction: Transaction,
  ownerUserId: string,
  scenario: PlayScenario
) {
  const [row] = await transaction.select({ value: max(gamePlayPlans.queueOrder) }).from(gamePlayPlans).where(and(
    eq(gamePlayPlans.ownerUserId, ownerUserId),
    eq(gamePlayPlans.scenario, scenario),
    eq(gamePlayPlans.state, "QUEUED")
  ));
  return Math.min(9999, (row?.value ?? 0) + 10);
}

export async function applyPlayPlannerAction(ownerUserId: string, input: PlayPlannerAction, requestId: string = randomUUID()) {
  return db.transaction(async (transaction) => {
    if (input.action === "SAVE_BUDGETS") {
      const value = { commuteWeeklyMinutes: input.commuteWeeklyMinutes, fixedWeeklyMinutes: input.fixedWeeklyMinutes };
      await transaction.insert(userPreferences).values({ ownerUserId, namespace: "play_planner", value })
        .onConflictDoUpdate({
          target: [userPreferences.ownerUserId, userPreferences.namespace],
          set: { value, updatedAt: new Date() }
        });
      await transaction.insert(auditLogs).values({ actorUserId: ownerUserId, action: "play_planner.budgets.update", entityType: "play_planner", outcome: "SUCCESS", requestId, metadata: value });
      return { kind: "BUDGETS" as const };
    }

    await lockPlayPlannerOwner(transaction, ownerUserId);

    // Serialize plan writes with completion updates. updateGame locks this same
    // row before archiving plans, so a concurrent planner action either lands
    // before that archive or observes isCompleted=true and fails closed.
    const game = (await transaction.select().from(games).where(and(
      eq(games.id, input.gameId), eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)
    )).limit(1).for("update"))[0];
    if (!game) throw new PlayPlannerError("GAME_NOT_FOUND", "游戏不存在");

    if (input.action === "SET_ACQUISITION") {
      const now = new Date();
      if (input.acquisitionId) {
        const currentAcquisition = (await transaction.select({ details: gameAcquisitions.details }).from(gameAcquisitions).where(and(
          eq(gameAcquisitions.id, input.acquisitionId),
          eq(gameAcquisitions.ownerUserId, ownerUserId),
          eq(gameAcquisitions.gameId, input.gameId)
        )).limit(1))[0];
        const [updated] = await transaction.update(gameAcquisitions).set({
          channel: input.channel,
          platform: input.platform,
          availability: input.availability,
          offlineCapable: input.offlineCapable,
          isOwned: input.channel === "PHYSICAL" || input.channel === "SELF_PURCHASED",
          details: { ...(currentAcquisition?.details ?? {}), classificationMode: "MANUAL", manuallyClassified: true },
          lastConfirmedAt: now,
          updatedAt: now,
          version: sql`${gameAcquisitions.version} + 1`
        }).where(and(
          eq(gameAcquisitions.id, input.acquisitionId),
          eq(gameAcquisitions.ownerUserId, ownerUserId),
          eq(gameAcquisitions.gameId, input.gameId),
          eq(gameAcquisitions.version, input.version!)
        )).returning();
        if (!updated) {
          const exists = await transaction.select({ id: gameAcquisitions.id }).from(gameAcquisitions).where(and(
            eq(gameAcquisitions.id, input.acquisitionId), eq(gameAcquisitions.ownerUserId, ownerUserId)
          )).limit(1);
          if (!exists.length) throw new PlayPlannerError("ACQUISITION_NOT_FOUND", "入手渠道不存在");
          throw new PlayPlannerError("CONFLICT", "入手渠道已被其他操作更新");
        }
      } else {
        await transaction.insert(gameAcquisitions).values({
          ownerUserId,
          gameId: input.gameId,
          source: "MANUAL",
          externalAcquisitionId: `planner:${randomUUID()}`,
          channel: input.channel,
          platform: input.platform,
          availability: input.availability,
          offlineCapable: input.offlineCapable,
          isOwned: input.channel === "PHYSICAL" || input.channel === "SELF_PURCHASED",
          lastConfirmedAt: now,
          details: { label: "手工渠道", classificationMode: "MANUAL", manuallyClassified: true }
        });
      }
      await reconcileWishlistForGames(transaction, ownerUserId, [input.gameId]);
      await transaction.insert(auditLogs).values({ actorUserId: ownerUserId, action: "game.acquisition.update", entityType: "game", entityId: input.gameId, outcome: "SUCCESS", requestId, metadata: { channel: input.channel, platform: input.platform, availability: input.availability, offlineCapable: input.offlineCapable } });
      return { kind: "ACQUISITION" as const };
    }

    if (input.action === "REMOVE_PLAN") {
      const [removed] = await transaction.delete(gamePlayPlans).where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.gameId, input.gameId),
        eq(gamePlayPlans.scenario, input.scenario), eq(gamePlayPlans.version, input.version)
      )).returning();
      if (!removed) throw new PlayPlannerError("CONFLICT", "游玩计划已更新，请刷新后重试");
      if (removed.state === "PLAYING") {
        const otherPlaying = await transaction.select({ id: gamePlayPlans.id }).from(gamePlayPlans).where(and(
          eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.gameId, input.gameId), eq(gamePlayPlans.state, "PLAYING")
        )).limit(1);
        if (!otherPlaying.length) await setLifecycleStatus(transaction, ownerUserId, input.gameId, "PAUSED");
      }
      await transaction.insert(auditLogs).values({ actorUserId: ownerUserId, action: "game.play_plan.remove", entityType: "game", entityId: input.gameId, outcome: "SUCCESS", requestId, metadata: { scenario: input.scenario } });
      return { kind: "PLAN" as const };
    }

    if (game.isCompleted) {
      throw new PlayPlannerError("GAME_COMPLETED", "已通关游戏不能加入游玩队列，请先撤销通关标记");
    }
    const abandoned = await transaction.select({ id: gameStatusAssignments.gameId }).from(gameStatusAssignments).where(and(
      eq(gameStatusAssignments.gameId, input.gameId),
      eq(gameStatusAssignments.status, "ABANDONED")
    )).limit(1);
    if (abandoned.length) {
      throw new PlayPlannerError("GAME_ABANDONED", "已弃坑游戏不能加入游玩队列，请先在游戏资料中恢复状态");
    }

    const moving = input.action === "MOVE_PLAN";
    const scenario = moving ? input.targetScenario : input.scenario;
    const state = moving ? input.targetState : input.state;
    const acquisitionId = input.acquisitionId;
    const preferredDevice = input.preferredDevice;
    const completionGoal = input.completionGoal;
    const requestedQueueOrder = input.queueOrder;
    const replaceCurrent = input.replaceCurrent;
    let sourcePlan: typeof gamePlayPlans.$inferSelect | null = null;
    if (moving) {
      sourcePlan = (await transaction.select().from(gamePlayPlans).where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId),
        eq(gamePlayPlans.gameId, input.gameId),
        eq(gamePlayPlans.scenario, input.sourceScenario)
      )).limit(1))[0] ?? null;
      if (!sourcePlan || sourcePlan.version !== input.sourceVersion) {
        throw new PlayPlannerError("CONFLICT", "原队列已更新，请刷新后重试");
      }
    }

    const acquisitions = await transaction.select().from(gameAcquisitions).where(and(
      eq(gameAcquisitions.ownerUserId, ownerUserId), eq(gameAcquisitions.gameId, input.gameId)
    ));
    const selected = acquisitionId ? acquisitions.find((item) => item.id === acquisitionId) : undefined;
    if (acquisitionId && !selected) throw new PlayPlannerError("ACQUISITION_NOT_FOUND", "入手渠道不存在");
    const available = (selected ? [selected] : acquisitions).filter((item) => item.availability === "AVAILABLE")
      .sort((left, right) => acquisitionRank(left.channel) - acquisitionRank(right.channel));
    const chosen = available.find((item) => acquisitionSupportsScenario({
      platform: item.platform,
      source: item.source,
      offlineCapable: item.offlineCapable,
      manuallyClassified: item.details.manuallyClassified === true
    }, scenario));
    if (!chosen) {
      if (scenario === "COMMUTE" && available.length) throw new PlayPlannerError("OFFLINE_REQUIRED", "当前平台不适合通勤便携；Switch 默认通勤、PlayStation 仅固定、Steam 默认双场景");
      throw new PlayPlannerError("ACQUISITION_REQUIRED", "加入游玩队列前需要可用的入手渠道");
    }
    const existing = (await transaction.select().from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.gameId, input.gameId), eq(gamePlayPlans.scenario, scenario)
    )).limit(1))[0];
    if (moving) {
      if (existing && (input.targetVersion === undefined || existing.version !== input.targetVersion)) {
        throw new PlayPlannerError("CONFLICT", "目标队列已更新，请刷新后重试");
      }
    } else if (existing && input.version !== undefined && existing.version !== input.version) {
      throw new PlayPlannerError("CONFLICT", "游玩计划已更新，请刷新后重试");
    }
    if (state === "PLAYING") {
      const occupied = (await transaction.select().from(gamePlayPlans).where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.scenario, scenario), eq(gamePlayPlans.state, "PLAYING")
      )).limit(1))[0];
      if (occupied && occupied.gameId !== input.gameId) {
        if (!replaceCurrent) throw new PlayPlannerError("SCENARIO_OCCUPIED", "该场景已有正在玩的游戏，请确认替换");
        await transaction.update(gamePlayPlans).set({
          state: "QUEUED",
          queueOrder: await nextPlanQueueOrder(transaction, ownerUserId, scenario),
          updatedAt: new Date(),
          version: sql`${gamePlayPlans.version} + 1`
        }).where(eq(gamePlayPlans.id, occupied.id));
        const otherScenarioPlaying = await transaction.select({ id: gamePlayPlans.id }).from(gamePlayPlans).where(and(
          eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.gameId, occupied.gameId), eq(gamePlayPlans.state, "PLAYING")
        )).limit(1);
        if (!otherScenarioPlaying.length) await setLifecycleStatus(transaction, ownerUserId, occupied.gameId, "PAUSED");
      }
    }
    if (moving && sourcePlan) {
      const [removedSource] = await transaction.delete(gamePlayPlans).where(and(
        eq(gamePlayPlans.id, sourcePlan.id), eq(gamePlayPlans.version, input.sourceVersion)
      )).returning({ id: gamePlayPlans.id });
      if (!removedSource) throw new PlayPlannerError("CONFLICT", "原队列已更新，请刷新后重试");
    }
    const queueOrder = state === "QUEUED"
      ? (requestedQueueOrder ?? existing?.queueOrder ?? await nextPlanQueueOrder(transaction, ownerUserId, scenario))
      : null;
    await transaction.insert(gamePlayPlans).values({
      ownerUserId,
      gameId: input.gameId,
      scenario,
      state,
      acquisitionId: chosen.id,
      preferredDevice,
      completionGoal,
      queueOrder
    }).onConflictDoUpdate({
      target: [gamePlayPlans.ownerUserId, gamePlayPlans.gameId, gamePlayPlans.scenario],
      set: {
        state,
        acquisitionId: chosen.id,
        preferredDevice,
        completionGoal,
        queueOrder,
        updatedAt: new Date(),
        version: sql`${gamePlayPlans.version} + 1`
      }
    });
    if (state === "PLAYING") {
      await setLifecycleStatus(transaction, ownerUserId, input.gameId, "PLAYING");
    } else {
      const stillPlaying = await transaction.select({ id: gamePlayPlans.id }).from(gamePlayPlans).where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId), eq(gamePlayPlans.gameId, input.gameId), eq(gamePlayPlans.state, "PLAYING")
      )).limit(1);
      if (!stillPlaying.length) await setLifecycleStatus(transaction, ownerUserId, input.gameId, "BACKLOG");
    }
    await transaction.insert(auditLogs).values({ actorUserId: ownerUserId, action: moving ? "game.play_plan.move" : "game.play_plan.update", entityType: "game", entityId: input.gameId, outcome: "SUCCESS", requestId, metadata: { scenario, state, sourceScenario: moving ? input.sourceScenario : null, channel: chosen.channel, acquisitionId: chosen.id, queueOrder, completionGoal, preferredDevice, replaceCurrent } });
    return { kind: "PLAN" as const };
  });
}
