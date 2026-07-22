import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { GameStatus } from "@/lib/game-status";
import type { PlayScenario } from "@/lib/play-planning";
import { db } from "@/server/db";
import {
  auditLogs,
  gamePlayPlans,
  games,
  gameStatusAssignments
} from "@/server/db/schema";

export type PlayPlanTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const lifecycleStatuses: GameStatus[] = [
  "BACKLOG",
  "PLAYING",
  "PLAYED",
  "PAUSED",
  "ABANDONED",
  "UNPLANNED",
  "UNRELEASED",
  "TO_BUY",
  "WISHLIST"
];

/**
 * All mutations that can occupy or release a play slot share one owner-scoped
 * lock. This keeps planner writes and terminal status updates in a single lock
 * order and prevents two concurrent completions from promoting two games into
 * the same scenario.
 */
export async function lockPlayPlannerOwner(transaction: PlayPlanTransaction, ownerUserId: string) {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`play-planner:${ownerUserId}`}, 0))`);
}

export async function setLifecycleStatus(
  transaction: PlayPlanTransaction,
  ownerUserId: string,
  gameId: string,
  status: "BACKLOG" | "PLAYING" | "PAUSED"
) {
  await transaction.delete(gameStatusAssignments).where(and(
    eq(gameStatusAssignments.gameId, gameId),
    inArray(gameStatusAssignments.status, lifecycleStatuses)
  ));
  await transaction.insert(gameStatusAssignments).values({ gameId, status });
  await transaction.update(games).set({
    playStatus: status,
    // game_play_plans is the only scheduling authority. The legacy game-level
    // order must not make a candidate look scheduled.
    queueOrder: null,
    updatedAt: new Date(),
    version: sql`${games.version} + 1`
  }).where(and(eq(games.id, gameId), eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)));
}

/**
 * Archive terminal games and promote the first globally ordered queued plan
 * that belongs to each vacated scenario. The status fact, plan deletion and
 * promotion are committed atomically.
 */
export async function archivePlayPlansAndPromote(
  transaction: PlayPlanTransaction,
  ownerUserId: string,
  gameIds: string[],
  requestId: string,
  reason: "COMPLETED" | "ABANDONED" | "BULK_TERMINAL"
) {
  const uniqueGameIds = [...new Set(gameIds)];
  if (!uniqueGameIds.length) return [];

  await lockPlayPlannerOwner(transaction, ownerUserId);
  const archivedPlans = await transaction.select().from(gamePlayPlans).where(and(
    eq(gamePlayPlans.ownerUserId, ownerUserId),
    inArray(gamePlayPlans.gameId, uniqueGameIds)
  )).for("update");
  const vacatedScenarios = [...new Set(
    archivedPlans.filter((plan) => plan.state === "PLAYING").map((plan) => plan.scenario)
  )] as PlayScenario[];

  await transaction.delete(gamePlayPlans).where(and(
    eq(gamePlayPlans.ownerUserId, ownerUserId),
    inArray(gamePlayPlans.gameId, uniqueGameIds)
  ));

  const promoted: Array<{ scenario: PlayScenario; gameId: string; planId: string }> = [];
  for (const scenario of vacatedScenarios) {
    const occupied = await transaction.select({ id: gamePlayPlans.id }).from(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, ownerUserId),
      eq(gamePlayPlans.scenario, scenario),
      eq(gamePlayPlans.state, "PLAYING")
    )).limit(1);
    if (occupied.length) continue;

    const [next] = await transaction.select({
      id: gamePlayPlans.id,
      gameId: gamePlayPlans.gameId
    }).from(gamePlayPlans)
      .innerJoin(games, eq(games.id, gamePlayPlans.gameId))
      .where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId),
        eq(gamePlayPlans.scenario, scenario),
        eq(gamePlayPlans.state, "QUEUED"),
        eq(games.ownerUserId, ownerUserId),
        eq(games.isCompleted, false),
        isNull(games.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${gameStatusAssignments} AS abandoned_status
          WHERE abandoned_status.game_id = ${gamePlayPlans.gameId}
            AND abandoned_status.status = 'ABANDONED'
        )`
      ))
      .orderBy(
        asc(gamePlayPlans.queueOrder),
        asc(gamePlayPlans.createdAt),
        asc(gamePlayPlans.id)
      )
      .limit(1)
      .for("update");
    if (!next) continue;

    await transaction.update(gamePlayPlans).set({
      state: "PLAYING",
      queueOrder: null,
      updatedAt: new Date(),
      version: sql`${gamePlayPlans.version} + 1`
    }).where(eq(gamePlayPlans.id, next.id));
    await setLifecycleStatus(transaction, ownerUserId, next.gameId, "PLAYING");
    promoted.push({ scenario, gameId: next.gameId, planId: next.id });
  }

  if (promoted.length) {
    await transaction.insert(auditLogs).values(promoted.map((entry) => ({
      actorUserId: ownerUserId,
      action: "game.play_plan.auto_promote",
      entityType: "game",
      entityId: entry.gameId,
      outcome: "SUCCESS" as const,
      requestId,
      metadata: {
        scenario: entry.scenario,
        planId: entry.planId,
        reason,
        archivedGameIds: uniqueGameIds
      }
    })));
  }
  return promoted;
}
