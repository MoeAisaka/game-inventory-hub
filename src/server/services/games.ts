import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  gameStatusValues,
  legacyGameStatusValues,
  legacyStatusFor,
  uniqueGameStatuses,
  type GameStatus
} from "@/lib/game-status";
import { deriveActivityState, derivePurchaseState } from "@/lib/game-insights";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  auditLogs,
  gameAcquisitions,
  gameFieldLocks,
  gamePlaySessions,
  gameReleaseEvents,
  games,
  gameStatusAssignments
} from "@/server/db/schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "日期不合法");

const nullableDate = isoDate.nullable();
const nullableText = (length: number) => z.string().trim().max(length).nullable();
const playStatus = z.enum(legacyGameStatusValues);
const gameStatus = z.enum(gameStatusValues);
const queryBoolean = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const statusFilter = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}, z.array(gameStatus).max(gameStatusValues.length).transform(uniqueGameStatuses).default([]));

const platformFilter = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}, z.array(z.string().trim().min(1).max(60)).max(20).transform((values) => [...new Set(values)]).default([]));

const gameFields = z.object({
  nameZh: z.string().trim().min(1).max(200),
  nameEn: nullableText(200).optional(),
  notes: nullableText(5000).optional(),
  platform: nullableText(60).optional(),
  mediaType: nullableText(60).optional(),
  ownershipStatus: nullableText(60).optional(),
  queueOrder: z.number().int().min(1).max(9999).nullable().optional(),
  releaseDate: nullableDate.optional(),
  communityRating: z.number().min(0).max(100).nullable().optional(),
  criticRating: z.number().min(0).max(100).nullable().optional(),
  ratingSource: z.enum(["MANUAL", "STEAM", "IGDB", "RAWG", "METACRITIC", "IGN", "XIAOHEIHE"]).nullable().optional(),
  statuses: z.array(gameStatus).max(gameStatusValues.length).transform(uniqueGameStatuses).optional(),
  playStatus: playStatus.nullable().optional(),
  startedAt: nullableDate.optional(),
  completedAt: nullableDate.optional(),
  progressPercent: z.number().int().min(0).max(100).nullable().optional(),
  playtimeMinutesManual: z.number().int().min(0).nullable().optional(),
  repeatable: z.boolean().optional(),
  manualOwned: z.boolean().optional(),
  acquisitionNotes: nullableText(2000).optional()
});

type ManualMetadataField = typeof gameFieldLocks.$inferInsert["field"];

function manualMetadataFields(input: Record<string, unknown>) {
  const fields: ManualMetadataField[] = [];
  const mapping: Array<[string, ManualMetadataField]> = [
    ["nameZh", "NAME_ZH"],
    ["nameEn", "NAME_EN"],
    ["releaseDate", "RELEASE_DATE"],
    ["communityRating", "COMMUNITY_RATING"],
    ["criticRating", "CRITIC_RATING"]
  ];
  for (const [inputField, metadataField] of mapping) {
    if (Object.prototype.hasOwnProperty.call(input, inputField)) fields.push(metadataField);
  }
  return fields;
}

async function lockManualMetadata(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  gameId: string,
  ownerUserId: string,
  fields: ManualMetadataField[]
) {
  if (!fields.length) return;
  await transaction.insert(gameFieldLocks).values(fields.map((field) => ({
    gameId,
    field,
    lockedByUserId: ownerUserId
  }))).onConflictDoNothing();
}

async function setManualAcquisition(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ownerUserId: string,
  gameId: string,
  isOwned: boolean
) {
  const now = new Date();
  await transaction.insert(gameAcquisitions).values({
    ownerUserId,
    gameId,
    source: "MANUAL",
    externalAcquisitionId: `manual:${gameId}`,
    isOwned,
    lastConfirmedAt: now,
    details: { label: "手工入库" }
  }).onConflictDoUpdate({
    target: [gameAcquisitions.ownerUserId, gameAcquisitions.source, gameAcquisitions.externalAcquisitionId],
    set: { gameId, isOwned, lastConfirmedAt: now, updatedAt: now }
  });
}

function validateDateOrder(value: { startedAt?: string | null; completedAt?: string | null }, context: z.RefinementCtx) {
  if (value.startedAt && value.completedAt && value.completedAt < value.startedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "完成日期不能早于开始日期" });
  }
}

function requestedStatuses(value: { statuses?: GameStatus[]; playStatus?: z.infer<typeof playStatus> | null }) {
  if (value.statuses !== undefined) return uniqueGameStatuses(value.statuses);
  if (value.playStatus !== undefined) return value.playStatus ? [value.playStatus] : [];
  return undefined;
}

function validateQueue(value: { statuses?: GameStatus[]; playStatus?: z.infer<typeof playStatus> | null; queueOrder?: number | null }, context: z.RefinementCtx) {
  const statuses = requestedStatuses(value) ?? [];
  if (value.queueOrder !== null && value.queueOrder !== undefined && !statuses.includes("BACKLOG")) {
    context.addIssue({ code: "custom", path: ["queueOrder"], message: "只有待玩游戏可以设置待玩顺序" });
  }
}

function releaseDedupeKey(gameId: string) {
  return `game:${gameId}:primary`;
}

async function replacePrimaryReleaseEvent(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  game: typeof games.$inferSelect
) {
  await replacePrimaryReleaseEvents(transaction, [game]);
}

async function replacePrimaryReleaseEvents(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  records: Array<typeof games.$inferSelect>
) {
  if (!records.length) return;
  const dedupeKeys = records.map((record) => releaseDedupeKey(record.id));
  await transaction.delete(gameReleaseEvents).where(and(
    eq(gameReleaseEvents.ownerUserId, records[0].ownerUserId),
    inArray(gameReleaseEvents.dedupeKey, dedupeKeys)
  ));
  const values = records.filter((game) => game.releaseDate && game.platform && !game.deletedAt).map((game) => ({
    ownerUserId: game.ownerUserId,
    gameId: game.id,
    source: game.releaseDateSource,
    dedupeKey: releaseDedupeKey(game.id),
    externalGameId: game.steamAppId ? String(game.steamAppId) : game.igdbGameId ? String(game.igdbGameId) : null,
    nameZh: game.nameZh,
    nameEn: game.nameEn,
    platform: game.platform!,
    releaseDate: game.releaseDate!,
    region: "GLOBAL",
    coverUrl: game.coverUrl
  }));
  if (values.length) await transaction.insert(gameReleaseEvents).values(values);
}

export const createGameSchema = gameFields.superRefine((value, context) => {
  validateDateOrder(value, context);
  validateQueue(value, context);
});

export const updateGameSchema = gameFields.partial().extend({
  version: z.number().int().positive()
}).superRefine(validateDateOrder);

export const gameQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  status: statusFilter,
  platform: platformFilter,
  sort: z.enum(["updated_desc", "name_asc", "release_asc", "queue_asc"]).default("queue_asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  includeDeleted: queryBoolean
});

const bulkSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("IDS"),
    ids: z.array(z.string().uuid()).min(1).max(1000).transform((values) => [...new Set(values)])
  }),
  z.object({
    mode: z.literal("FILTER"),
    query: gameQuerySchema.pick({ q: true, status: true, platform: true, sort: true }),
    excludedIds: z.array(z.string().uuid()).max(1000).transform((values) => [...new Set(values)]).default([]),
    expectedTotal: z.number().int().min(1).max(1000)
  })
]);

const bulkActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("STATUSES"),
    mode: z.enum(["ADD", "REMOVE", "REPLACE"]),
    statuses: z.array(gameStatus).min(1).max(gameStatusValues.length).transform(uniqueGameStatuses)
  }),
  z.object({ type: z.literal("PLATFORM"), platform: z.string().trim().min(1).max(60).nullable() }),
  z.object({
    type: z.literal("QUEUE"),
    start: z.number().int().min(1).max(9999),
    step: z.number().int().min(1).max(9999).default(1)
  }),
  z.object({ type: z.literal("DELETE") })
]);

export const bulkGameSchema = z.object({
  selection: bulkSelectionSchema,
  action: bulkActionSchema
});

export const playSessionSchema = z.object({
  minutes: z.number().int().min(1).max(24 * 60),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable().optional(),
  notes: nullableText(2000).optional()
}).superRefine((value, context) => {
  if (value.endedAt && value.endedAt < value.startedAt) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "结束时间不能早于开始时间" });
  }
});

function escapedLike(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function gameConditions(ownerUserId: string, input: Pick<z.infer<typeof gameQuerySchema>, "q" | "status" | "platform" | "includeDeleted">) {
  const conditions = [eq(games.ownerUserId, ownerUserId)];
  if (!input.includeDeleted) conditions.push(isNull(games.deletedAt));
  if (input.q) {
    const pattern = escapedLike(input.q);
    conditions.push(or(
      sql`${games.nameZh} ILIKE ${pattern} ESCAPE '\\'`,
      sql`${games.nameEn} ILIKE ${pattern} ESCAPE '\\'`,
      sql`${games.notes} ILIKE ${pattern} ESCAPE '\\'`
    )!);
  }
  if (input.status.length) conditions.push(sql`exists (
    select 1 from ${gameStatusAssignments}
    where ${gameStatusAssignments.gameId} = ${games.id}
      and ${inArray(gameStatusAssignments.status, input.status)}
  )`);
  if (input.platform.length) conditions.push(inArray(games.platform, input.platform));
  return conditions;
}

function gameOrder(sort: z.infer<typeof gameQuerySchema>["sort"]) {
  const isBacklog = sql`exists (
    select 1 from ${gameStatusAssignments}
    where ${gameStatusAssignments.gameId} = ${games.id}
      and ${gameStatusAssignments.status} = 'BACKLOG'
  )`;
  return sort === "name_asc" ? [asc(games.nameZh)]
    : sort === "release_asc" ? [sql`${games.releaseDate} ASC NULLS LAST`, asc(games.nameZh)]
      : sort === "queue_asc" ? [
        sql`CASE WHEN ${isBacklog} AND ${games.queueOrder} IS NOT NULL THEN 0 WHEN ${isBacklog} THEN 1 ELSE 2 END`,
        sql`${games.queueOrder} ASC NULLS LAST`,
        asc(games.nameZh)
      ]
        : [desc(games.updatedAt)];
}

export async function listGames(ownerUserId: string, input: z.infer<typeof gameQuerySchema>) {
  const conditions = gameConditions(ownerUserId, input);
  const order = gameOrder(input.sort);
  const where = and(...conditions);
  const [records, [total]] = await Promise.all([
    db.select().from(games).where(where).orderBy(...order).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(games).where(where)
  ]);
  const gameIds = records.map((record) => record.id);
  const [statusMap, acquisitionMap] = await Promise.all([
    statusesFor(gameIds),
    acquisitionSourcesFor(gameIds)
  ]);
  return {
    games: records.map((record) => withInsights(record, statusMap.get(record.id), acquisitionMap.get(record.id))),
    total: total.value,
    page: input.page,
    pageSize: input.pageSize
  };
}

type GameTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BulkInput = z.infer<typeof bulkGameSchema>;

async function resolveBulkSelection(
  transaction: GameTransaction,
  ownerUserId: string,
  selection: BulkInput["selection"]
) {
  if (selection.mode === "IDS") {
    const rows = await transaction.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt),
      inArray(games.id, selection.ids)
    ));
    if (rows.length !== selection.ids.length) throw new Error("BULK_SELECTION_STALE");
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selection.ids.map((id) => byId.get(id)!);
  }

  const where = and(...gameConditions(ownerUserId, {
    ...selection.query,
    includeDeleted: false
  }));
  const rows = await transaction.select().from(games).where(where).orderBy(...gameOrder(selection.query.sort));
  if (rows.length !== selection.expectedTotal) throw new Error("BULK_SELECTION_STALE");
  const excluded = new Set(selection.excludedIds);
  return rows.filter((row) => !excluded.has(row.id));
}

async function applyBulkStatusAction(
  transaction: GameTransaction,
  records: Array<typeof games.$inferSelect>,
  action: Extract<BulkInput["action"], { type: "STATUSES" }>
) {
  const ids = records.map((record) => record.id);
  const assignedRows = await transaction.select().from(gameStatusAssignments)
    .where(inArray(gameStatusAssignments.gameId, ids));
  const assigned = new Map<string, GameStatus[]>();
  for (const row of assignedRows) assigned.set(row.gameId, [...(assigned.get(row.gameId) ?? []), row.status]);
  const requested = new Set<GameStatus>(action.statuses);
  const targets = records.map((record) => {
    const current = uniqueGameStatuses(assigned.get(record.id) ?? (record.playStatus ? [record.playStatus] : []));
    const statuses = action.mode === "REPLACE" ? action.statuses
      : action.mode === "ADD" ? uniqueGameStatuses([...current, ...action.statuses])
        : current.filter((status) => !requested.has(status));
    return { id: record.id, statuses };
  });

  await transaction.delete(gameStatusAssignments).where(inArray(gameStatusAssignments.gameId, ids));
  const statusValues = targets.flatMap((target) => target.statuses.map((status) => ({ gameId: target.id, status })));
  if (statusValues.length) await transaction.insert(gameStatusAssignments).values(statusValues);
  const values = sql.join(targets.map((target) => sql`(
    ${target.id}::uuid,
    CAST(${legacyStatusFor(target.statuses)} AS game_play_status),
    ${target.statuses.includes("BACKLOG")}::boolean
  )`), sql`, `);
  await transaction.execute(sql`
    WITH target(id, play_status, has_backlog) AS (VALUES ${values})
    UPDATE ${games} AS game
    SET play_status = target.play_status,
        queue_order = CASE WHEN target.has_backlog THEN game.queue_order ELSE NULL END,
        updated_at = NOW(),
        version = game.version + 1
    FROM target
    WHERE game.id = target.id
  `);
}

async function applyBulkQueueAction(
  transaction: GameTransaction,
  records: Array<typeof games.$inferSelect>,
  action: Extract<BulkInput["action"], { type: "QUEUE" }>
) {
  const last = action.start + (records.length - 1) * action.step;
  if (last > 9999) throw new Error("BULK_QUEUE_RANGE");
  await transaction.insert(gameStatusAssignments).values(records.map((record) => ({
    gameId: record.id,
    status: "BACKLOG" as const
  }))).onConflictDoNothing();
  const values = sql.join(records.map((record, index) => sql`(
    ${record.id}::uuid,
    ${action.start + index * action.step}::integer
  )`), sql`, `);
  await transaction.execute(sql`
    WITH target(id, queue_order) AS (VALUES ${values})
    UPDATE ${games} AS game
    SET queue_order = target.queue_order,
        play_status = COALESCE(game.play_status, 'BACKLOG'::game_play_status),
        updated_at = NOW(),
        version = game.version + 1
    FROM target
    WHERE game.id = target.id
  `);
}

export async function bulkManageGames(
  ownerUserId: string,
  input: BulkInput,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    const records = await resolveBulkSelection(transaction, ownerUserId, input.selection);
    if (!records.length) throw new Error("BULK_SELECTION_EMPTY");
    if (records.length > 1000) throw new Error("BULK_SELECTION_LIMIT");
    const ids = records.map((record) => record.id);

    if (input.action.type === "STATUSES") {
      await applyBulkStatusAction(transaction, records, input.action);
    } else if (input.action.type === "QUEUE") {
      await applyBulkQueueAction(transaction, records, input.action);
    } else if (input.action.type === "PLATFORM") {
      const updated = await transaction.update(games).set({
        platform: input.action.platform,
        platformSource: "MANUAL",
        updatedAt: new Date(),
        version: sql`${games.version} + 1`
      }).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt), inArray(games.id, ids))).returning();
      await replacePrimaryReleaseEvents(transaction, updated);
    } else {
      const deleted = await transaction.update(games).set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        version: sql`${games.version} + 1`
      }).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt), inArray(games.id, ids))).returning();
      await replacePrimaryReleaseEvents(transaction, deleted);
    }

    await transaction.insert(auditLogs).values({
      actorUserId: ownerUserId,
      action: `game.bulk.${input.action.type.toLowerCase()}`,
      entityType: "game_bulk",
      entityId: null,
      outcome: "SUCCESS",
      requestId,
      metadata: {
        count: records.length,
        selectionMode: input.selection.mode,
        action: input.action,
        sampleIds: ids.slice(0, 20)
      }
    });
    return { updatedCount: records.length };
  });
  return result;
}

async function statusesFor(gameIds: string[]) {
  const map = new Map<string, GameStatus[]>();
  if (!gameIds.length) return map;
  const rows = await db.select().from(gameStatusAssignments).where(inArray(gameStatusAssignments.gameId, gameIds));
  for (const row of rows) map.set(row.gameId, [...(map.get(row.gameId) ?? []), row.status]);
  for (const [gameId, statuses] of map) map.set(gameId, uniqueGameStatuses(statuses));
  return map;
}

async function acquisitionSourcesFor(gameIds: string[]) {
  const map = new Map<string, string[]>();
  if (!gameIds.length) return map;
  const rows = await db.select({ gameId: gameAcquisitions.gameId, source: gameAcquisitions.source })
    .from(gameAcquisitions)
    .where(and(inArray(gameAcquisitions.gameId, gameIds), eq(gameAcquisitions.isOwned, true)));
  for (const row of rows) {
    const sources = map.get(row.gameId) ?? [];
    if (!sources.includes(row.source)) sources.push(row.source);
    map.set(row.gameId, sources);
  }
  return map;
}

function withStatuses<T extends { playStatus: z.infer<typeof playStatus> | null }>(record: T, assigned?: GameStatus[]) {
  return { ...record, statuses: assigned?.length ? assigned : record.playStatus ? [record.playStatus] : [] };
}

function withInsights<T extends {
  playStatus: z.infer<typeof playStatus> | null;
  ownershipStatus: string | null;
  playtimeMinutesManual: number | null;
  playtimeMinutesSynced: number;
  lastPlayedAt: Date | null;
  playtimeLastChangedAt: Date | null;
}>(record: T, assigned?: GameStatus[], acquisitionSources: string[] = []) {
  const game = withStatuses(record, assigned);
  const totalPlaytimeMinutes = game.playtimeMinutesManual ?? game.playtimeMinutesSynced;
  return {
    ...game,
    totalPlaytimeMinutes,
    acquisitionSources,
    purchaseState: derivePurchaseState({
      hasAcquisition: acquisitionSources.length > 0,
      ownershipStatus: game.ownershipStatus,
      statuses: game.statuses
    }),
    activityState: deriveActivityState({
      statuses: game.statuses,
      totalPlaytimeMinutes,
      lastPlayedAt: game.lastPlayedAt,
      playtimeLastChangedAt: game.playtimeLastChangedAt
    })
  };
}

export async function getGame(ownerUserId: string, gameId: string, includeDeleted = false) {
  const conditions = [eq(games.id, gameId), eq(games.ownerUserId, ownerUserId)];
  if (!includeDeleted) conditions.push(isNull(games.deletedAt));
  const record = (await db.select().from(games).where(and(...conditions)).limit(1))[0] ?? null;
  if (!record) return null;
  const [statusMap, acquisitionMap] = await Promise.all([
    statusesFor([record.id]),
    acquisitionSourcesFor([record.id])
  ]);
  return withInsights(record, statusMap.get(record.id), acquisitionMap.get(record.id));
}

export async function createGame(
  ownerUserId: string,
  input: z.infer<typeof createGameSchema>,
  requestId: string = randomUUID()
) {
  const { statuses: rawStatuses, playStatus: rawPlayStatus, manualOwned, ...fields } = input;
  const statuses = requestedStatuses({ statuses: rawStatuses, playStatus: rawPlayStatus }) ?? [];
  const record = await db.transaction(async (transaction) => {
    const [created] = await transaction.insert(games).values({
      ownerUserId,
      ...fields,
      playStatus: legacyStatusFor(statuses),
      releaseDateSource: "MANUAL",
      nameEnSource: input.nameEn ? "MANUAL" : "IMPORT",
      ratingSource: input.communityRating !== null && input.communityRating !== undefined || input.criticRating !== null && input.criticRating !== undefined
        ? (input.ratingSource ?? "MANUAL")
        : null,
      ratingUpdatedAt: input.communityRating !== null && input.communityRating !== undefined || input.criticRating !== null && input.criticRating !== undefined
        ? new Date()
        : null,
      platformSource: input.platform ?? null
    }).returning();
    if (statuses.length) await transaction.insert(gameStatusAssignments).values(statuses.map((status) => ({ gameId: created.id, status })));
    await lockManualMetadata(transaction, created.id, ownerUserId, manualMetadataFields(input));
    if (manualOwned !== undefined) await setManualAcquisition(transaction, ownerUserId, created.id, manualOwned);
    await replacePrimaryReleaseEvent(transaction, created);
    return withStatuses(created, statuses);
  });
  await writeAudit({ actorUserId: ownerUserId, action: "game.create", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId });
  return record;
}

export async function updateGame(
  ownerUserId: string,
  gameId: string,
  input: z.infer<typeof updateGameSchema>,
  requestId: string = randomUUID()
) {
  const { version, statuses: rawStatuses, playStatus: rawPlayStatus, manualOwned, ...changes } = input;
  const current = await getGame(ownerUserId, gameId);
  if (!current) return null;
  if (current.version !== version) return { conflict: true as const, current };
  const startedAt = Object.prototype.hasOwnProperty.call(changes, "startedAt") ? changes.startedAt : current.startedAt;
  const completedAt = Object.prototype.hasOwnProperty.call(changes, "completedAt") ? changes.completedAt : current.completedAt;
  if (startedAt && completedAt && completedAt < startedAt) throw new Error("GAME_DATE_ORDER");
  const statusUpdateRequested = rawStatuses !== undefined || rawPlayStatus !== undefined;
  const statuses = statusUpdateRequested
    ? requestedStatuses({ statuses: rawStatuses, playStatus: rawPlayStatus }) ?? []
    : current.statuses;
  const queueOrderSpecified = Object.prototype.hasOwnProperty.call(changes, "queueOrder");
  const effectiveQueueOrder = queueOrderSpecified ? changes.queueOrder : current.queueOrder;
  if (queueOrderSpecified && effectiveQueueOrder !== null && effectiveQueueOrder !== undefined && !statuses.includes("BACKLOG")) {
    throw new Error("GAME_QUEUE_STATUS");
  }
  const patch: Record<string, unknown> = { ...changes, updatedAt: new Date(), version: sql`${games.version} + 1` };
  if (Object.prototype.hasOwnProperty.call(changes, "releaseDate") && changes.releaseDate !== current.releaseDate) patch.releaseDateSource = "MANUAL";
  if (Object.prototype.hasOwnProperty.call(changes, "nameEn") && changes.nameEn !== current.nameEn) patch.nameEnSource = "MANUAL";
  if (Object.prototype.hasOwnProperty.call(changes, "communityRating") || Object.prototype.hasOwnProperty.call(changes, "criticRating")) {
    patch.ratingSource = changes.communityRating === null && changes.criticRating === null
      ? null
      : (changes.ratingSource ?? "MANUAL");
    patch.ratingUpdatedAt = new Date();
  }
  if (statusUpdateRequested) patch.playStatus = legacyStatusFor(statuses);
  if (!statuses.includes("BACKLOG")) patch.queueOrder = null;
  const record = await db.transaction(async (transaction) => {
    const [updated] = await transaction.update(games).set(patch).where(and(
      eq(games.id, gameId),
      eq(games.ownerUserId, ownerUserId),
      eq(games.version, version),
      isNull(games.deletedAt)
    )).returning();
    if (!updated) return null;
    if (statusUpdateRequested) {
      await transaction.delete(gameStatusAssignments).where(eq(gameStatusAssignments.gameId, gameId));
      if (statuses.length) await transaction.insert(gameStatusAssignments).values(statuses.map((status) => ({ gameId, status })));
    }
    await lockManualMetadata(transaction, gameId, ownerUserId, manualMetadataFields(changes));
    if (manualOwned !== undefined) await setManualAcquisition(transaction, ownerUserId, gameId, manualOwned);
    await replacePrimaryReleaseEvent(transaction, updated);
    return withStatuses(updated, statuses);
  });
  if (!record) {
    const exists = await getGame(ownerUserId, gameId, true);
    return exists ? { conflict: true as const, current: exists } : null;
  }
  await writeAudit({ actorUserId: ownerUserId, action: "game.update", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId, metadata: { fields: [...Object.keys(changes), ...(statusUpdateRequested ? ["statuses"] : [])] } });
  return { conflict: false as const, game: record };
}

export async function deleteGame(ownerUserId: string, gameId: string, requestId: string = randomUUID()) {
  const record = await db.transaction(async (transaction) => {
    const [deleted] = await transaction.update(games).set({
      deletedAt: new Date(),
      updatedAt: new Date(),
      version: sql`${games.version} + 1`
    }).where(and(eq(games.id, gameId), eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt))).returning();
    if (deleted) await replacePrimaryReleaseEvent(transaction, deleted);
    return deleted;
  });
  if (!record) return getGame(ownerUserId, gameId, true);
  await writeAudit({ actorUserId: ownerUserId, action: "game.delete", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId });
  return record;
}

export async function restoreGame(ownerUserId: string, gameId: string, requestId: string = randomUUID()) {
  const record = await db.transaction(async (transaction) => {
    const [restored] = await transaction.update(games).set({
      deletedAt: null,
      updatedAt: new Date(),
      version: sql`${games.version} + 1`
    }).where(and(eq(games.id, gameId), eq(games.ownerUserId, ownerUserId))).returning();
    if (restored) await replacePrimaryReleaseEvent(transaction, restored);
    return restored;
  });
  if (!record) return null;
  await writeAudit({ actorUserId: ownerUserId, action: "game.restore", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId });
  return record;
}

export async function addPlaySession(
  ownerUserId: string,
  gameId: string,
  input: z.infer<typeof playSessionSchema>,
  requestId: string = randomUUID()
) {
  const existing = await getGame(ownerUserId, gameId);
  if (!existing) return null;
  const result = await db.transaction(async (transaction) => {
    const [session] = await transaction.insert(gamePlaySessions).values({ gameId, ...input, source: "MANUAL" }).returning();
    const [game] = await transaction.update(games).set({
      playtimeMinutesManual: sql`COALESCE(${games.playtimeMinutesManual}, 0) + ${input.minutes}`,
      lastPlayedAt: input.endedAt ?? input.startedAt,
      updatedAt: new Date(),
      version: sql`${games.version} + 1`
    }).where(eq(games.id, gameId)).returning();
    return { session, game };
  });
  await writeAudit({ actorUserId: ownerUserId, action: "game.play_session.create", entityType: "game", entityId: gameId, outcome: "SUCCESS", requestId, metadata: { minutes: input.minutes } });
  return result;
}
