import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { auditLogs, gameStatusAssignments, games } from "@/server/db/schema";
import { legacyStatusFor, uniqueGameStatuses, type GameStatus } from "@/lib/game-status";

export type AutoPlayedPreview = {
  asOf: string;
  cutoff: string;
  inactivityHours: number;
  eligibleCount: number;
  changeCount: number;
  missingLastPlayedCount: number;
  candidateSha256: string;
  sampleIds: string[];
};

function normalizedOptions(options: { asOf?: Date; inactivityHours?: number } = {}) {
  const asOf = options.asOf ?? new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error("AUTO_PLAYED_AS_OF_INVALID");
  const inactivityHours = options.inactivityHours ?? 48;
  if (!Number.isInteger(inactivityHours) || inactivityHours < 1 || inactivityHours > 8_760) {
    throw new Error("AUTO_PLAYED_HOURS_INVALID");
  }
  return { asOf, inactivityHours, cutoff: new Date(asOf.getTime() - inactivityHours * 60 * 60 * 1_000) };
}

async function candidateRows(ownerUserId: string, options: { asOf?: Date; inactivityHours?: number } = {}) {
  const normalized = normalizedOptions(options);
  const eligible = await db.select({ id: games.id }).from(games).where(and(
    eq(games.ownerUserId, ownerUserId),
    isNull(games.deletedAt),
    or(sql`${games.playtimeMinutesManual} > 0`, sql`${games.playtimeMinutesSynced} > 0`),
    lt(games.lastPlayedAt, normalized.cutoff)
  )).orderBy(games.id);
  const ids = eligible.map((row) => row.id);
  const assignments = ids.length
    ? await db.select({ gameId: gameStatusAssignments.gameId, status: gameStatusAssignments.status })
      .from(gameStatusAssignments).where(inArray(gameStatusAssignments.gameId, ids))
    : [];
  const statuses = new Map<string, GameStatus[]>();
  for (const row of assignments) statuses.set(row.gameId, [...(statuses.get(row.gameId) ?? []), row.status]);
  const changeIds = ids.filter((id) => {
    const values = statuses.get(id) ?? [];
    // PLAYING is an explicit plan chosen by the user. Stale platform activity
    // may suggest a completion candidate, but it must never overwrite that
    // intentional lifecycle state.
    return !values.includes("PLAYED") && !values.includes("PLAYING");
  });
  const [missingLastPlayed] = await db.select({ count: sql<number>`count(*)::int` }).from(games).where(and(
    eq(games.ownerUserId, ownerUserId),
    isNull(games.deletedAt),
    or(sql`${games.playtimeMinutesManual} > 0`, sql`${games.playtimeMinutesSynced} > 0`),
    isNull(games.lastPlayedAt)
  ));
  return { ...normalized, ids, changeIds, statuses, missingLastPlayedCount: missingLastPlayed?.count ?? 0 };
}

export async function previewAutoPlayedGames(
  ownerUserId: string,
  options: { asOf?: Date; inactivityHours?: number } = {}
): Promise<AutoPlayedPreview> {
  const rows = await candidateRows(ownerUserId, options);
  return {
    asOf: rows.asOf.toISOString(),
    cutoff: rows.cutoff.toISOString(),
    inactivityHours: rows.inactivityHours,
    eligibleCount: rows.ids.length,
    changeCount: rows.changeIds.length,
    missingLastPlayedCount: rows.missingLastPlayedCount,
    candidateSha256: createHash("sha256").update(rows.changeIds.join("\n")).digest("hex"),
    sampleIds: rows.changeIds.slice(0, 20)
  };
}

export async function autoClassifyPlayedGames(
  ownerUserId: string,
  options: {
    asOf?: Date;
    inactivityHours?: number;
    expectedCandidateSha256?: string;
    requestId?: string;
  } = {}
) {
  const preview = await previewAutoPlayedGames(ownerUserId, options);
  if (options.expectedCandidateSha256 && options.expectedCandidateSha256 !== preview.candidateSha256) {
    throw new Error("AUTO_PLAYED_CANDIDATE_CHANGED");
  }
  if (!preview.changeCount) return { ...preview, updatedCount: 0, removedPlaying: 0, removedCompleted: 0 };

  const requestId = options.requestId ?? randomUUID();
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`game-inventory-auto-played:${ownerUserId}`}))`);
    const ids = preview.sampleIds.length === preview.changeCount
      ? preview.sampleIds
      : (await candidateRows(ownerUserId, options)).changeIds;
    const freshSha = createHash("sha256").update(ids.join("\n")).digest("hex");
    if (freshSha !== preview.candidateSha256) throw new Error("AUTO_PLAYED_CANDIDATE_CHANGED");

    const prior = await transaction.select({ gameId: gameStatusAssignments.gameId, status: gameStatusAssignments.status })
      .from(gameStatusAssignments).where(inArray(gameStatusAssignments.gameId, ids));
    const priorByGame = new Map<string, GameStatus[]>();
    for (const row of prior) priorByGame.set(row.gameId, [...(priorByGame.get(row.gameId) ?? []), row.status]);
    const removedPlaying = prior.filter((row) => row.status === "PLAYING").length;
    const preservedCompleted = prior.filter((row) => row.status === "COMPLETED").length;

    await transaction.delete(gameStatusAssignments).where(and(
      inArray(gameStatusAssignments.gameId, ids),
      eq(gameStatusAssignments.status, "PLAYING")
    ));
    await transaction.insert(gameStatusAssignments).values(ids.map((gameId) => ({ gameId, status: "PLAYED" as const })))
      .onConflictDoNothing();

    for (const id of ids) {
      const priorStatuses = priorByGame.get(id) ?? [];
      const statuses = uniqueGameStatuses([...priorStatuses.filter((status) => status !== "PLAYING"), "PLAYED"]);
      await transaction.update(games).set({
        playStatus: legacyStatusFor(statuses),
        updatedAt: options.asOf ?? new Date(),
        version: sql`${games.version} + 1`
      }).where(and(eq(games.id, id), eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)));
    }

    await transaction.insert(auditLogs).values({
      actorUserId: ownerUserId,
      action: "game.status.auto_played",
      entityType: "game_bulk",
      entityId: null,
      outcome: "SUCCESS",
      requestId,
      metadata: {
        inactivityHours: preview.inactivityHours,
        asOf: preview.asOf,
        cutoff: preview.cutoff,
        candidateSha256: preview.candidateSha256,
        eligibleCount: preview.eligibleCount,
        updatedCount: ids.length,
        removedPlaying,
        removedCompleted: 0,
        preservedCompleted,
        sampleIds: ids.slice(0, 20)
      }
    });
    return { ...preview, updatedCount: ids.length, removedPlaying, removedCompleted: 0, preservedCompleted };
  });
}
