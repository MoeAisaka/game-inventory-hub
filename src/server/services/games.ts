import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  gameStatusValues,
  legacyGameStatusValues,
  legacyStatusFor,
  persistedGameStatuses,
  statusesWithCompletion,
  uniqueGameStatuses,
  type GameStatus
} from "@/lib/game-status";
import { deriveActivityState, derivePurchaseState } from "@/lib/game-state-engine";
import { gameGenreValues } from "@/lib/game-genres";
import {
  dualsenseEnvironmentValues,
  dualsenseFeatureLevelValues,
  legacyPs5ProfileFromGame,
  dualsenseProfileMatrix,
  pcWiredRequirementValues,
  rayTracingLevelValues,
  type DualsenseProfile
} from "@/lib/game-hardware";
import type { AcquisitionChannel } from "@/lib/play-planning";
import { gameSearchVariants, normalizeGameSearchAliases, normalizeGameSearchText } from "@/lib/game-search";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { reconcileWishlistForGames } from "@/server/services/game-wishlist";
import {
  auditLogs,
  gameAcquisitions,
  gameDualsenseProfiles,
  gameFieldLocks,
  gamePlayPlans,
  gamePlaySessions,
  gameReleaseEvents,
  games,
  gameStatusAssignments,
  platformLibraryItems,
  steamLibraryItems
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

const genreFilter = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}, z.array(z.enum(gameGenreValues)).max(gameGenreValues.length).transform((values) => [...new Set(values)]).default([]));

const dualsenseProfileSchema = z.object({
  environment: z.enum(dualsenseEnvironmentValues),
  adaptiveTriggers: z.enum(dualsenseFeatureLevelValues),
  hapticFeedback: z.enum(dualsenseFeatureLevelValues),
  controllerSpeaker: z.enum(dualsenseFeatureLevelValues),
  touchpad: z.enum(dualsenseFeatureLevelValues),
  controllerMic: z.enum(dualsenseFeatureLevelValues),
  notes: nullableText(2000)
}).strict();

const dualsenseProfilesSchema = z.array(dualsenseProfileSchema).length(dualsenseEnvironmentValues.length)
  .superRefine((profiles, context) => {
    const environments = new Set(profiles.map((profile) => profile.environment));
    for (const environment of dualsenseEnvironmentValues) {
      if (!environments.has(environment)) context.addIssue({
        code: "custom",
        message: `缺少 ${environment} DualSense 档案`
      });
    }
    if (environments.size !== profiles.length) context.addIssue({ code: "custom", message: "DualSense 运行环境不可重复" });
  });

const gameFields = z.object({
  nameZh: z.string().trim().min(1).max(200),
  nameEn: nullableText(200).optional(),
  searchAliases: z.array(z.string().trim().min(1).max(200)).max(30).transform(normalizeGameSearchAliases).optional(),
  notes: nullableText(5000).optional(),
  platform: nullableText(60).optional(),
  primaryGenre: z.enum(gameGenreValues).nullable().optional(),
  subGenres: z.array(z.enum(gameGenreValues)).max(gameGenreValues.length).transform((values) => [...new Set(values)]).optional(),
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
  acquisitionNotes: nullableText(2000).optional(),
  dualsenseProfiles: dualsenseProfilesSchema.optional(),
  dualsenseAdaptiveTriggers: z.enum(dualsenseFeatureLevelValues).optional(),
  dualsenseHapticFeedback: z.enum(dualsenseFeatureLevelValues).optional(),
  dualsenseControllerSpeaker: z.enum(dualsenseFeatureLevelValues).optional(),
  dualsenseTouchpad: z.enum(dualsenseFeatureLevelValues).optional(),
  dualsenseControllerMic: z.enum(dualsenseFeatureLevelValues).optional(),
  dualsenseNotes: nullableText(2000).optional(),
  pcWiredRequired: z.enum(pcWiredRequirementValues).optional(),
  rayTracing: z.enum(rayTracingLevelValues).optional(),
  rayTracingNotes: nullableText(2000).optional()
});

const hardwareProfileInputFields = [
  "dualsenseProfiles",
  "dualsenseAdaptiveTriggers",
  "dualsenseHapticFeedback",
  "dualsenseControllerSpeaker",
  "dualsenseTouchpad",
  "dualsenseControllerMic",
  "dualsenseNotes",
  "pcWiredRequired",
  "rayTracing",
  "rayTracingNotes"
] as const;

function touchesHardwareProfile(input: Record<string, unknown>) {
  return hardwareProfileInputFields.some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

type ManualMetadataField = typeof gameFieldLocks.$inferInsert["field"];

function manualMetadataFields(input: Record<string, unknown>) {
  const fields: ManualMetadataField[] = [];
  const mapping: Array<[string, ManualMetadataField]> = [
    ["nameZh", "NAME_ZH"],
    ["nameEn", "NAME_EN"],
    ["releaseDate", "RELEASE_DATE"],
    ["communityRating", "COMMUNITY_RATING"],
    ["criticRating", "CRITIC_RATING"],
    ["primaryGenre", "PRIMARY_GENRE"],
    ["subGenres", "SUB_GENRES"],
    ["dualsenseProfiles", "DUALSENSE_PROFILE"],
    ["dualsenseAdaptiveTriggers", "DUALSENSE_PROFILE"],
    ["dualsenseHapticFeedback", "DUALSENSE_PROFILE"],
    ["dualsenseControllerSpeaker", "DUALSENSE_PROFILE"],
    ["dualsenseTouchpad", "DUALSENSE_PROFILE"],
    ["dualsenseControllerMic", "DUALSENSE_PROFILE"],
    ["dualsenseNotes", "DUALSENSE_PROFILE"],
    ["pcWiredRequired", "DUALSENSE_PROFILE"],
    ["rayTracing", "RAY_TRACING_PROFILE"],
    ["rayTracingNotes", "RAY_TRACING_PROFILE"]
  ];
  for (const [inputField, metadataField] of mapping) {
    if (Object.prototype.hasOwnProperty.call(input, inputField)) fields.push(metadataField);
  }
  return [...new Set(fields)];
}

function legacyProfilePatch(profiles: readonly DualsenseProfile[]) {
  const matrix = dualsenseProfileMatrix(profiles);
  const ps5 = matrix.PS5_CONSOLE;
  const usb = matrix.PC_USB;
  const bluetooth = matrix.PC_BLUETOOTH;
  const usbKnown = [usb.adaptiveTriggers, usb.hapticFeedback, usb.controllerSpeaker, usb.touchpad, usb.controllerMic]
    .some((level) => level !== "UNKNOWN");
  const bluetoothHasFeature = [bluetooth.adaptiveTriggers, bluetooth.hapticFeedback, bluetooth.controllerSpeaker, bluetooth.touchpad, bluetooth.controllerMic]
    .some((level) => level === "BASIC" || level === "RICH");
  const bluetoothExplicitlyNone = [bluetooth.adaptiveTriggers, bluetooth.hapticFeedback, bluetooth.controllerSpeaker, bluetooth.touchpad, bluetooth.controllerMic]
    .every((level) => level === "NONE");
  return {
    dualsenseAdaptiveTriggers: ps5.adaptiveTriggers,
    dualsenseHapticFeedback: ps5.hapticFeedback,
    dualsenseControllerSpeaker: ps5.controllerSpeaker,
    dualsenseTouchpad: ps5.touchpad,
    dualsenseControllerMic: ps5.controllerMic,
    dualsenseNotes: ps5.notes,
    pcWiredRequired: bluetoothHasFeature ? "FALSE" as const : usbKnown && bluetoothExplicitlyNone ? "TRUE" as const : "UNKNOWN" as const
  };
}

function legacyFeatureInputTouched(input: Record<string, unknown>) {
  return [
    "dualsenseAdaptiveTriggers",
    "dualsenseHapticFeedback",
    "dualsenseControllerSpeaker",
    "dualsenseTouchpad",
    "dualsenseControllerMic",
    "dualsenseNotes"
  ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function profilesFromLegacyCreate(input: Record<string, unknown>) {
  const matrix = dualsenseProfileMatrix([]);
  matrix.PS5_CONSOLE = {
    environment: "PS5_CONSOLE",
    adaptiveTriggers: (input.dualsenseAdaptiveTriggers ?? "UNKNOWN") as DualsenseProfile["adaptiveTriggers"],
    hapticFeedback: (input.dualsenseHapticFeedback ?? "UNKNOWN") as DualsenseProfile["hapticFeedback"],
    controllerSpeaker: (input.dualsenseControllerSpeaker ?? "UNKNOWN") as DualsenseProfile["controllerSpeaker"],
    touchpad: (input.dualsenseTouchpad ?? "UNKNOWN") as DualsenseProfile["touchpad"],
    controllerMic: (input.dualsenseControllerMic ?? "UNKNOWN") as DualsenseProfile["controllerMic"],
    notes: (input.dualsenseNotes ?? null) as string | null
  };
  return dualsenseEnvironmentValues.map((environment) => matrix[environment]);
}

async function replaceDualsenseProfiles(
  transaction: GameTransaction,
  ownerUserId: string,
  gameId: string,
  profiles: readonly DualsenseProfile[],
  source: "MANUAL" | "IMPORT"
) {
  for (const profile of profiles) {
    await transaction.insert(gameDualsenseProfiles).values({
      ownerUserId,
      gameId,
      ...profile,
      source
    }).onConflictDoUpdate({
      target: [gameDualsenseProfiles.gameId, gameDualsenseProfiles.environment],
      set: {
        adaptiveTriggers: profile.adaptiveTriggers,
        hapticFeedback: profile.hapticFeedback,
        controllerSpeaker: profile.controllerSpeaker,
        touchpad: profile.touchpad,
        controllerMic: profile.controllerMic,
        notes: profile.notes,
        source,
        version: sql`${gameDualsenseProfiles.version} + 1`,
        updatedAt: new Date()
      }
    });
  }
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

const wishlistIncompatibleStatuses = new Set<GameStatus>([
  "BACKLOG", "PLAYING", "PLAYED", "PAUSED", "ABANDONED", "UNPLANNED"
]);

function normalizeWishlistStatuses(statuses: readonly GameStatus[]) {
  const unique = uniqueGameStatuses(statuses);
  return unique.includes("WISHLIST") || unique.includes("TO_BUY")
    ? uniqueGameStatuses([
      ...unique.filter((status) => status !== "WISHLIST" && status !== "TO_BUY" && !wishlistIncompatibleStatuses.has(status)),
      "TO_BUY"
    ])
    : unique;
}

function validateQueue(value: { statuses?: GameStatus[]; playStatus?: z.infer<typeof playStatus> | null; queueOrder?: number | null }, context: z.RefinementCtx) {
  const statuses = requestedStatuses(value) ?? [];
  if (value.queueOrder !== null && value.queueOrder !== undefined && !statuses.includes("BACKLOG")) {
    context.addIssue({ code: "custom", path: ["queueOrder"], message: "只有“接下来玩”的游戏可以设置顺序" });
  }
}

function validateCompletion(value: { statuses?: GameStatus[]; playStatus?: z.infer<typeof playStatus> | null; completedAt?: string | null }, context: z.RefinementCtx) {
  const statuses = requestedStatuses(value);
  if (value.completedAt && statuses !== undefined && !statuses.includes("COMPLETED")) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "填写完成日期时必须标记为已通关" });
  }
  if (statuses?.includes("COMPLETED") && statuses.includes("ABANDONED")) {
    context.addIssue({ code: "custom", path: ["statuses"], message: "已通关和弃坑不能同时标记" });
  }
}

function validateDualsenseInput(value: Record<string, unknown>, context: z.RefinementCtx) {
  const legacyFields = [
    "dualsenseAdaptiveTriggers",
    "dualsenseHapticFeedback",
    "dualsenseControllerSpeaker",
    "dualsenseTouchpad",
    "dualsenseControllerMic",
    "dualsenseNotes",
    "pcWiredRequired"
  ];
  if (Object.prototype.hasOwnProperty.call(value, "dualsenseProfiles")
    && legacyFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    context.addIssue({
      code: "custom",
      path: ["dualsenseProfiles"],
      message: "分环境档案不能与旧版单档案字段同时提交"
    });
  }
  if (!Object.prototype.hasOwnProperty.call(value, "dualsenseProfiles")
    && Object.prototype.hasOwnProperty.call(value, "pcWiredRequired")) {
    context.addIssue({
      code: "custom",
      path: ["pcWiredRequired"],
      message: "旧版 PC 有线布尔值已停写，请提交 PS5 主机、PC USB、PC 蓝牙完整档案"
    });
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
  validateCompletion(value, context);
  validateDualsenseInput(value, context);
});

export const updateGameSchema = gameFields.partial().extend({
  version: z.number().int().positive()
}).superRefine((value, context) => {
  validateDateOrder(value, context);
  validateCompletion(value, context);
  validateDualsenseInput(value, context);
});

export const gameQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  status: statusFilter,
  platform: platformFilter,
  genre: genreFilter,
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
    query: gameQuerySchema.pick({ q: true, status: true, platform: true, genre: true, sort: true }),
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
}).superRefine((value, context) => {
  if (value.action.type === "STATUSES"
    && value.action.statuses.includes("COMPLETED")
    && value.action.statuses.includes("ABANDONED")) {
    context.addIssue({ code: "custom", path: ["action", "statuses"], message: "已通关和弃坑不能同时标记" });
  }
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

export const quickGameStatusSchema = z.object({
  action: z.enum(["START", "STOP", "PAUSE", "ABANDON", "COMPLETE", "UNCOMPLETE"]),
  version: z.number().int().positive(),
  completedAt: nullableDate.optional()
});

export const quickGameWishlistSchema = z.object({
  active: z.boolean(),
  version: z.number().int().positive()
});

type QuickGameStatusAction = z.infer<typeof quickGameStatusSchema>["action"];

export function gameStatusesAfterQuickAction(statuses: readonly GameStatus[], action: QuickGameStatusAction) {
  const completion = statuses.includes("COMPLETED");
  const withoutLifecycle = statuses.filter((status) => ![
    "BACKLOG", "PLAYING", "PLAYED", "PAUSED", "ABANDONED", "UNPLANNED", "UNRELEASED", "TO_BUY", "WISHLIST"
  ].includes(status));
  if (action === "UNCOMPLETE") return uniqueGameStatuses(statuses.filter((status) => status !== "COMPLETED"));
  if (action === "START") return uniqueGameStatuses([...withoutLifecycle, ...(completion ? ["COMPLETED" as const] : []), "PLAYING"]);
  if (action === "STOP") return uniqueGameStatuses([...withoutLifecycle, ...(completion ? ["COMPLETED" as const] : []), "PLAYED"]);
  if (action === "PAUSE") return uniqueGameStatuses([...withoutLifecycle, ...(completion ? ["COMPLETED" as const] : []), "PAUSED"]);
  // COMPLETE and ABANDONED are mutually exclusive archive outcomes. A quick
  // transition replaces the previous outcome instead of creating a game that
  // is simultaneously completed and abandoned.
  if (action === "ABANDON") return uniqueGameStatuses([
    ...withoutLifecycle.filter((status) => status !== "COMPLETED"),
    "ABANDONED"
  ]);
  return uniqueGameStatuses([...withoutLifecycle, "PLAYED", "COMPLETED"]);
}

function shanghaiIsoDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function escapedLike(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function fuzzyThreshold(value: string) {
  return value.length <= 4 ? 0.32 : value.length <= 7 ? 0.36 : 0.4;
}

function normalizedSql(column: typeof games.nameZh | typeof games.nameEn) {
  return sql`regexp_replace(lower(coalesce(${column}, '')), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g')`;
}

function fuzzyNameCondition(column: typeof games.nameZh | typeof games.nameEn, query: string) {
  const pattern = escapedLike(query);
  const normalizedQuery = normalizeGameSearchText(query);
  const normalizedPattern = escapedLike(normalizedQuery);
  const base = [
    sql`${column} ILIKE ${pattern} ESCAPE '\\'`,
    ...(normalizedQuery ? [sql`${normalizedSql(column)} ILIKE ${normalizedPattern} ESCAPE '\\'`] : [])
  ];
  if (normalizedQuery.length < 3) return or(...base)!;
  const threshold = fuzzyThreshold(normalizedQuery);
  return or(
    ...base,
    sql`similarity(lower(coalesce(${column}, '')), lower(${query})) >= ${threshold}`,
    sql`word_similarity(lower(${query}), lower(coalesce(${column}, ''))) >= ${threshold}`,
    sql`similarity(${normalizedSql(column)}, ${normalizedQuery}) >= ${threshold}`
  )!;
}

function platformAliasSearchCondition(ownerUserId: string, query: string) {
  const pattern = escapedLike(query);
  const normalizedQuery = normalizeGameSearchText(query);
  const threshold = fuzzyThreshold(normalizedQuery);
  const steamFuzzy = normalizedQuery.length >= 3
    ? sql`or similarity(lower(${steamLibraryItems.name}), lower(${query})) >= ${threshold}
        or word_similarity(lower(${query}), lower(${steamLibraryItems.name})) >= ${threshold}`
    : sql``;
  const platformFuzzy = normalizedQuery.length >= 3
    ? sql`or similarity(lower(${platformLibraryItems.name}), lower(${query})) >= ${threshold}
        or word_similarity(lower(${query}), lower(${platformLibraryItems.name})) >= ${threshold}`
    : sql``;
  return or(
    sql`exists (
      select 1 from ${steamLibraryItems}
      where ${steamLibraryItems.ownerUserId} = ${ownerUserId}
        and ${steamLibraryItems.matchedGameId} = ${games.id}
        and ${steamLibraryItems.matchStatus} = 'MATCHED'
        and (${steamLibraryItems.name} ilike ${pattern} escape '\\' ${steamFuzzy})
    )`,
    sql`exists (
      select 1 from ${platformLibraryItems}
      where ${platformLibraryItems.ownerUserId} = ${ownerUserId}
        and ${platformLibraryItems.matchedGameId} = ${games.id}
        and ${platformLibraryItems.matchStatus} = 'MATCHED'
        and (${platformLibraryItems.name} ilike ${pattern} escape '\\' ${platformFuzzy})
    )`
  )!;
}

function curatedAliasSearchCondition(query: string) {
  const pattern = escapedLike(query);
  const normalizedQuery = normalizeGameSearchText(query);
  const normalizedPattern = escapedLike(normalizedQuery);
  const threshold = fuzzyThreshold(normalizedQuery);
  const fuzzy = normalizedQuery.length >= 3
    ? sql`or similarity(lower(alias.value), lower(${query})) >= ${threshold}
        or word_similarity(lower(${query}), lower(alias.value)) >= ${threshold}
        or similarity(
          regexp_replace(lower(alias.value), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g'),
          ${normalizedQuery}
        ) >= ${threshold}`
    : sql``;
  return sql`exists (
    select 1
    from jsonb_array_elements_text(coalesce(${games.searchAliases}, '[]'::jsonb)) as alias(value)
    where alias.value ilike ${pattern} escape '\\'
      or regexp_replace(lower(alias.value), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g') ilike ${normalizedPattern} escape '\\'
      ${fuzzy}
  )`;
}

function searchVariantCondition(ownerUserId: string, query: string) {
  const pattern = escapedLike(query);
  return or(
    fuzzyNameCondition(games.nameZh, query),
    fuzzyNameCondition(games.nameEn, query),
    sql`${games.notes} ILIKE ${pattern} ESCAPE '\\'`,
    curatedAliasSearchCondition(query),
    platformAliasSearchCondition(ownerUserId, query)
  )!;
}

function searchVariantRelevance(ownerUserId: string, query: string) {
  const pattern = escapedLike(query);
  const normalizedQuery = normalizeGameSearchText(query);
  const normalizedPattern = escapedLike(normalizedQuery);
  const fuzzyScore = normalizedQuery.length >= 3
    ? sql`greatest(
        similarity(lower(coalesce(${games.nameZh}, '')), lower(${query})),
        similarity(lower(coalesce(${games.nameEn}, '')), lower(${query})),
        word_similarity(lower(${query}), lower(coalesce(${games.nameZh}, ''))),
        word_similarity(lower(${query}), lower(coalesce(${games.nameEn}, '')))
      ) * 60`
    : sql`0`;
  return sql`case
    when lower(${games.nameZh}) = lower(${query}) or lower(coalesce(${games.nameEn}, '')) = lower(${query}) then 120
    when ${games.nameZh} ilike ${pattern} escape '\\' or ${games.nameEn} ilike ${pattern} escape '\\' then 100
    when ${normalizedSql(games.nameZh)} ilike ${normalizedPattern} escape '\\'
      or ${normalizedSql(games.nameEn)} ilike ${normalizedPattern} escape '\\' then 90
    when ${curatedAliasSearchCondition(query)} then 88
    when ${platformAliasSearchCondition(ownerUserId, query)} then 80
    else ${fuzzyScore}
  end`;
}

function searchRelevance(ownerUserId: string, query: string) {
  const variants = gameSearchVariants(query);
  return variants.length === 1
    ? searchVariantRelevance(ownerUserId, variants[0])
    : sql`greatest(${sql.join(variants.map((variant) => searchVariantRelevance(ownerUserId, variant)), sql`, `)})`;
}

function gameConditions(ownerUserId: string, input: Pick<z.infer<typeof gameQuerySchema>, "q" | "status" | "platform" | "genre" | "includeDeleted">) {
  const conditions = [eq(games.ownerUserId, ownerUserId)];
  if (!input.includeDeleted) conditions.push(isNull(games.deletedAt));
  if (input.q) {
    conditions.push(or(...gameSearchVariants(input.q).map((variant) => searchVariantCondition(ownerUserId, variant)))!);
  }
  if (input.status.length) {
    const persisted = input.status.filter((status) => status !== "COMPLETED");
    const statusConditions = [
      ...(persisted.length ? [sql`exists (
        select 1 from ${gameStatusAssignments}
        where ${gameStatusAssignments.gameId} = ${games.id}
          and ${inArray(gameStatusAssignments.status, persisted)}
      )`] : []),
      ...(input.status.includes("COMPLETED") ? [eq(games.isCompleted, true)] : [])
    ];
    conditions.push(or(...statusConditions)!);
  }
  if (input.platform.length) conditions.push(inArray(games.platform, input.platform));
  if (input.genre.length) {
    const genreArray = sql`ARRAY[${sql.join(input.genre.map((genre) => sql`${genre}`), sql`, `)}]::game_genre[]`;
    conditions.push(or(
      inArray(games.primaryGenre, input.genre),
      sql`${games.subGenres} && ${genreArray}`
    )!);
  }
  return conditions;
}

function gameOrder(sort: z.infer<typeof gameQuerySchema>["sort"], query = "", ownerUserId = "") {
  const isBacklog = sql`exists (
    select 1 from ${gameStatusAssignments}
    where ${gameStatusAssignments.gameId} = ${games.id}
      and ${gameStatusAssignments.status} = 'BACKLOG'
  )`;
  const baseOrder = sort === "name_asc" ? [asc(games.nameZh)]
    : sort === "release_asc" ? [sql`${games.releaseDate} ASC NULLS LAST`, asc(games.nameZh)]
      : sort === "queue_asc" ? [
        sql`CASE WHEN ${isBacklog} AND ${games.queueOrder} IS NOT NULL THEN 0 WHEN ${isBacklog} THEN 1 ELSE 2 END`,
        sql`${games.queueOrder} ASC NULLS LAST`,
        asc(games.nameZh)
      ]
        : [desc(games.updatedAt)];
  return query ? [desc(searchRelevance(ownerUserId, query)), ...baseOrder] : baseOrder;
}

async function dualsenseProfilesFor(ownerUserId: string, gameIds: string[]) {
  const map = new Map<string, DualsenseProfile[]>();
  if (!gameIds.length) return map;
  const rows = await db.select({
    gameId: gameDualsenseProfiles.gameId,
    environment: gameDualsenseProfiles.environment,
    adaptiveTriggers: gameDualsenseProfiles.adaptiveTriggers,
    hapticFeedback: gameDualsenseProfiles.hapticFeedback,
    controllerSpeaker: gameDualsenseProfiles.controllerSpeaker,
    touchpad: gameDualsenseProfiles.touchpad,
    controllerMic: gameDualsenseProfiles.controllerMic,
    notes: gameDualsenseProfiles.notes
  }).from(gameDualsenseProfiles).where(and(
    eq(gameDualsenseProfiles.ownerUserId, ownerUserId),
    inArray(gameDualsenseProfiles.gameId, gameIds)
  ));
  for (const { gameId, ...profile } of rows) map.set(gameId, [...(map.get(gameId) ?? []), profile]);
  return map;
}

function withDualsenseProfiles<T extends typeof games.$inferSelect>(record: T, profiles: readonly DualsenseProfile[] | undefined) {
  const matrix = dualsenseProfileMatrix(profiles, record);
  return { ...record, dualsenseProfiles: dualsenseEnvironmentValues.map((environment) => matrix[environment]) };
}

export async function listGames(ownerUserId: string, input: z.infer<typeof gameQuerySchema>) {
  const conditions = gameConditions(ownerUserId, input);
  const order = gameOrder(input.sort, input.q, ownerUserId);
  const where = and(...conditions);
  const [records, [total]] = await Promise.all([
    db.select().from(games).where(where).orderBy(...order).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(games).where(where)
  ]);
  const gameIds = records.map((record) => record.id);
  const [statusMap, acquisitionMap, dualsenseMap] = await Promise.all([
    statusesFor(gameIds),
    acquisitionFactsFor(gameIds),
    dualsenseProfilesFor(ownerUserId, gameIds)
  ]);
  return {
    games: records.map((record) => withInsights(
      withDualsenseProfiles(record, dualsenseMap.get(record.id)),
      statusMap.get(record.id),
      acquisitionMap.get(record.id)
    )),
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
  const rows = await transaction.select().from(games).where(where).orderBy(...gameOrder(selection.query.sort, selection.query.q, ownerUserId));
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
    const current = statusesWithCompletion(
      assigned.get(record.id) ?? (record.playStatus ? [record.playStatus] : []),
      record.isCompleted
    );
    let virtualStatuses = action.mode === "REPLACE" ? action.statuses
      : action.mode === "ADD" ? uniqueGameStatuses([...current, ...action.statuses])
        : current.filter((status) => !requested.has(status));
    if (action.mode !== "REMOVE" && action.statuses.some((status) => status === "WISHLIST" || status === "TO_BUY")) {
      virtualStatuses = normalizeWishlistStatuses(virtualStatuses);
    } else if (action.statuses.some((status) => wishlistIncompatibleStatuses.has(status))) {
      virtualStatuses = virtualStatuses.filter((status) => status !== "WISHLIST" && status !== "TO_BUY");
    }
    if (action.mode !== "REMOVE" && action.statuses.includes("ABANDONED")) {
      virtualStatuses = virtualStatuses.filter((status) => status !== "COMPLETED");
    } else if (action.mode !== "REMOVE" && action.statuses.includes("COMPLETED")) {
      virtualStatuses = virtualStatuses.filter((status) => status !== "ABANDONED");
    }
    return {
      id: record.id,
      statuses: persistedGameStatuses(virtualStatuses),
      isCompleted: virtualStatuses.includes("COMPLETED"),
      isArchived: virtualStatuses.includes("COMPLETED") || virtualStatuses.includes("ABANDONED")
    };
  });

  await transaction.delete(gameStatusAssignments).where(inArray(gameStatusAssignments.gameId, ids));
  const statusValues = targets.flatMap((target) => target.statuses.map((status) => ({ gameId: target.id, status })));
  if (statusValues.length) await transaction.insert(gameStatusAssignments).values(statusValues);
  const values = sql.join(targets.map((target) => sql`(
    ${target.id}::uuid,
    CAST(${legacyStatusFor(target.statuses)} AS game_play_status),
    ${target.statuses.includes("BACKLOG")}::boolean,
    ${target.isCompleted}::boolean
  )`), sql`, `);
  await transaction.execute(sql`
    WITH target(id, play_status, has_backlog, is_completed) AS (VALUES ${values})
    UPDATE ${games} AS game
    SET play_status = target.play_status,
        is_completed = target.is_completed,
        completed_at = CASE WHEN target.is_completed THEN game.completed_at ELSE NULL END,
        queue_order = CASE WHEN target.has_backlog THEN game.queue_order ELSE NULL END,
        updated_at = NOW(),
        version = game.version + 1
    FROM target
    WHERE game.id = target.id
  `);
  const archivedIds = targets.filter((target) => target.isArchived).map((target) => target.id);
  if (archivedIds.length) {
    await transaction.delete(gamePlayPlans).where(and(
      eq(gamePlayPlans.ownerUserId, records[0]!.ownerUserId),
      inArray(gamePlayPlans.gameId, archivedIds)
    ));
  }
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
  await transaction.delete(gameStatusAssignments).where(and(
    inArray(gameStatusAssignments.gameId, records.map((record) => record.id)),
    eq(gameStatusAssignments.status, "WISHLIST")
  ));
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
    if (input.action.type === "STATUSES" || input.action.type === "QUEUE") {
      await reconcileWishlistForGames(transaction, ownerUserId, ids);
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

type AcquisitionFacts = { sources: string[]; zeroCostChannels: AcquisitionChannel[] };

async function acquisitionFactsFor(gameIds: string[]) {
  const map = new Map<string, AcquisitionFacts>();
  if (!gameIds.length) return map;
  const rows = await db.select({
    gameId: gameAcquisitions.gameId,
    source: gameAcquisitions.source,
    channel: gameAcquisitions.channel,
    availability: gameAcquisitions.availability
  })
    .from(gameAcquisitions)
    .where(and(inArray(gameAcquisitions.gameId, gameIds), eq(gameAcquisitions.isOwned, true)));
  for (const row of rows) {
    const facts = map.get(row.gameId) ?? { sources: [], zeroCostChannels: [] };
    if (!facts.sources.includes(row.source)) facts.sources.push(row.source);
    if (
      (row.channel === "SUBSCRIPTION" || row.channel === "FAMILY_SHARED")
      && row.availability === "AVAILABLE"
      && !facts.zeroCostChannels.includes(row.channel)
    ) facts.zeroCostChannels.push(row.channel);
    map.set(row.gameId, facts);
  }
  return map;
}

function withStatuses<T extends { playStatus: z.infer<typeof playStatus> | null; isCompleted: boolean }>(record: T, assigned?: GameStatus[]) {
  const persisted = assigned?.length ? assigned : record.playStatus ? [record.playStatus] : [];
  return { ...record, statuses: statusesWithCompletion(persisted, record.isCompleted) };
}

function withInsights<T extends {
  playStatus: z.infer<typeof playStatus> | null;
  isCompleted: boolean;
  ownershipStatus: string | null;
  playtimeMinutesManual: number | null;
  playtimeMinutesSynced: number;
  lastPlayedAt: Date | null;
  playtimeLastChangedAt: Date | null;
  firstObservedPlayedAt: Date | null;
}>(record: T, assigned?: GameStatus[], acquisitionFacts?: AcquisitionFacts) {
  const game = withStatuses(record, assigned);
  const acquisitionSources = acquisitionFacts?.sources ?? [];
  const zeroCostChannels = acquisitionFacts?.zeroCostChannels ?? [];
  const totalPlaytimeMinutes = game.playtimeMinutesManual ?? game.playtimeMinutesSynced;
  const purchaseState = derivePurchaseState({
    hasAcquisition: acquisitionSources.length > 0,
    ownershipStatus: game.ownershipStatus,
    statuses: game.statuses
  });
  const hasPlayEvidence = Math.max(game.playtimeMinutesManual ?? 0, game.playtimeMinutesSynced) > 0
    || game.lastPlayedAt !== null
    || game.firstObservedPlayedAt !== null;
  return {
    ...game,
    totalPlaytimeMinutes,
    acquisitionSources,
    zeroCostChannels,
    purchaseState,
    wishlistEligible: !game.isCompleted && !hasPlayEvidence && purchaseState !== "OWNED",
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
  const [statusMap, acquisitionMap, dualsenseMap] = await Promise.all([
    statusesFor([record.id]),
    acquisitionFactsFor([record.id]),
    dualsenseProfilesFor(ownerUserId, [record.id])
  ]);
  return withInsights(
    withDualsenseProfiles(record, dualsenseMap.get(record.id)),
    statusMap.get(record.id),
    acquisitionMap.get(record.id)
  );
}

export async function createGame(
  ownerUserId: string,
  input: z.infer<typeof createGameSchema>,
  requestId: string = randomUUID()
) {
  const { statuses: rawStatuses, playStatus: rawPlayStatus, manualOwned, dualsenseProfiles, ...fields } = input;
  const effectiveDualsenseProfiles = dualsenseProfiles
    ?? (legacyFeatureInputTouched(fields) ? profilesFromLegacyCreate(fields) : undefined);
  const statuses = normalizeWishlistStatuses(requestedStatuses({ statuses: rawStatuses, playStatus: rawPlayStatus }) ?? []);
  const isCompleted = statuses.includes("COMPLETED") || Boolean(fields.completedAt);
  const persistedStatuses = persistedGameStatuses(statuses);
  const createdId = await db.transaction(async (transaction) => {
    const [created] = await transaction.insert(games).values({
      ownerUserId,
      ...fields,
      ...(effectiveDualsenseProfiles ? legacyProfilePatch(effectiveDualsenseProfiles) : {}),
      isCompleted,
      completedAt: isCompleted ? fields.completedAt : null,
      playStatus: legacyStatusFor(persistedStatuses),
      genreSource: fields.primaryGenre || fields.subGenres?.length ? "MANUAL" : null,
      hardwareProfileSource: touchesHardwareProfile(input) ? "MANUAL" : null,
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
    if (persistedStatuses.length) await transaction.insert(gameStatusAssignments).values(persistedStatuses.map((status) => ({ gameId: created.id, status })));
    if (effectiveDualsenseProfiles) await replaceDualsenseProfiles(transaction, ownerUserId, created.id, effectiveDualsenseProfiles, "MANUAL");
    await lockManualMetadata(transaction, created.id, ownerUserId, manualMetadataFields(input));
    if (manualOwned !== undefined) await setManualAcquisition(transaction, ownerUserId, created.id, manualOwned);
    await reconcileWishlistForGames(transaction, ownerUserId, [created.id]);
    await replacePrimaryReleaseEvent(transaction, created);
    return created.id;
  });
  const record = await getGame(ownerUserId, createdId);
  if (!record) throw new Error("GAME_CREATE_READBACK_FAILED");
  await writeAudit({ actorUserId: ownerUserId, action: "game.create", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId });
  return record;
}

export async function updateGame(
  ownerUserId: string,
  gameId: string,
  input: z.infer<typeof updateGameSchema>,
  requestId: string = randomUUID()
) {
  const { version, statuses: rawStatuses, playStatus: rawPlayStatus, manualOwned, dualsenseProfiles, ...changes } = input;
  const current = await getGame(ownerUserId, gameId);
  if (!current) return null;
  if (current.version !== version) return { conflict: true as const, current };
  let effectiveDualsenseProfiles = dualsenseProfiles;
  if (!effectiveDualsenseProfiles && legacyFeatureInputTouched(changes)) {
    const matrix = dualsenseProfileMatrix(current.dualsenseProfiles, current);
    matrix.PS5_CONSOLE = legacyPs5ProfileFromGame({ ...current, ...changes } as typeof games.$inferSelect);
    effectiveDualsenseProfiles = dualsenseEnvironmentValues.map((environment) => matrix[environment]);
  }
  const startedAt = Object.prototype.hasOwnProperty.call(changes, "startedAt") ? changes.startedAt : current.startedAt;
  const completedAt = Object.prototype.hasOwnProperty.call(changes, "completedAt") ? changes.completedAt : current.completedAt;
  if (startedAt && completedAt && completedAt < startedAt) throw new Error("GAME_DATE_ORDER");
  const statusUpdateRequested = rawStatuses !== undefined || rawPlayStatus !== undefined;
  const completionDateSpecified = Object.prototype.hasOwnProperty.call(changes, "completedAt");
  const statuses = statusUpdateRequested
    ? normalizeWishlistStatuses(requestedStatuses({ statuses: rawStatuses, playStatus: rawPlayStatus }) ?? [])
    : current.statuses;
  const isCompleted = statuses.includes("COMPLETED") || (!statusUpdateRequested && Boolean(changes.completedAt));
  const persistedStatuses = persistedGameStatuses(statuses);
  const queueOrderSpecified = Object.prototype.hasOwnProperty.call(changes, "queueOrder");
  const effectiveQueueOrder = queueOrderSpecified ? changes.queueOrder : current.queueOrder;
  if (queueOrderSpecified && effectiveQueueOrder !== null && effectiveQueueOrder !== undefined && !statuses.includes("BACKLOG")) {
    throw new Error("GAME_QUEUE_STATUS");
  }
  const patch: Record<string, unknown> = {
    ...changes,
    ...(effectiveDualsenseProfiles ? legacyProfilePatch(effectiveDualsenseProfiles) : {}),
    updatedAt: new Date(),
    version: sql`${games.version} + 1`
  };
  if (Object.prototype.hasOwnProperty.call(changes, "releaseDate") && changes.releaseDate !== current.releaseDate) patch.releaseDateSource = "MANUAL";
  if (Object.prototype.hasOwnProperty.call(changes, "nameEn") && changes.nameEn !== current.nameEn) patch.nameEnSource = "MANUAL";
  if (Object.prototype.hasOwnProperty.call(changes, "primaryGenre") || Object.prototype.hasOwnProperty.call(changes, "subGenres")) {
    const nextPrimaryGenre = Object.prototype.hasOwnProperty.call(changes, "primaryGenre") ? changes.primaryGenre : current.primaryGenre;
    const nextSubGenres = Object.prototype.hasOwnProperty.call(changes, "subGenres") ? changes.subGenres ?? [] : current.subGenres;
    patch.genreSource = nextPrimaryGenre || nextSubGenres.length ? "MANUAL" : null;
  }
  if (touchesHardwareProfile({ ...changes, ...(effectiveDualsenseProfiles ? { dualsenseProfiles: effectiveDualsenseProfiles } : {}) })) patch.hardwareProfileSource = "MANUAL";
  if (Object.prototype.hasOwnProperty.call(changes, "communityRating") || Object.prototype.hasOwnProperty.call(changes, "criticRating")) {
    patch.ratingSource = changes.communityRating === null && changes.criticRating === null
      ? null
      : (changes.ratingSource ?? "MANUAL");
    patch.ratingUpdatedAt = new Date();
  }
  if (statusUpdateRequested) {
    patch.isCompleted = isCompleted;
    patch.completedAt = isCompleted
      ? (completionDateSpecified ? changes.completedAt : current.completedAt)
      : null;
    patch.playStatus = legacyStatusFor(persistedStatuses);
  } else if (changes.completedAt) {
    patch.isCompleted = true;
  }
  if (!persistedStatuses.includes("BACKLOG")) patch.queueOrder = null;
  const updatedId = await db.transaction(async (transaction) => {
    const [updated] = await transaction.update(games).set(patch).where(and(
      eq(games.id, gameId),
      eq(games.ownerUserId, ownerUserId),
      eq(games.version, version),
      isNull(games.deletedAt)
    )).returning();
    if (!updated) return null;
    if (effectiveDualsenseProfiles) await replaceDualsenseProfiles(transaction, ownerUserId, gameId, effectiveDualsenseProfiles, "MANUAL");
    if (statusUpdateRequested) {
      await transaction.delete(gameStatusAssignments).where(eq(gameStatusAssignments.gameId, gameId));
      if (persistedStatuses.length) await transaction.insert(gameStatusAssignments).values(persistedStatuses.map((status) => ({ gameId, status })));
    }
    // COMPLETED and ABANDONED are archive boundaries: an archived game must
    // not continue to occupy either the current slot or a queued slot. Keep
    // this in the same transaction as the status fact so clients can never
    // observe an archived-but-still-planned intermediate state. Enforce it
    // even when an older caller sets completedAt without sending statuses.
    if (isCompleted || persistedStatuses.includes("ABANDONED")) {
      await transaction.delete(gamePlayPlans).where(and(
        eq(gamePlayPlans.ownerUserId, ownerUserId),
        eq(gamePlayPlans.gameId, gameId)
      ));
    }
    await lockManualMetadata(transaction, gameId, ownerUserId, manualMetadataFields({
      ...changes,
      ...(effectiveDualsenseProfiles ? { dualsenseProfiles: effectiveDualsenseProfiles } : {})
    }));
    if (manualOwned !== undefined) await setManualAcquisition(transaction, ownerUserId, gameId, manualOwned);
    await reconcileWishlistForGames(transaction, ownerUserId, [gameId]);
    await replacePrimaryReleaseEvent(transaction, updated);
    return updated.id;
  });
  if (!updatedId) {
    const exists = await getGame(ownerUserId, gameId, true);
    return exists ? { conflict: true as const, current: exists } : null;
  }
  const record = await getGame(ownerUserId, updatedId);
  if (!record) throw new Error("GAME_UPDATE_READBACK_FAILED");
  await writeAudit({ actorUserId: ownerUserId, action: "game.update", entityType: "game", entityId: record.id, outcome: "SUCCESS", requestId, metadata: { fields: [...Object.keys(changes), ...(effectiveDualsenseProfiles ? ["dualsenseProfiles"] : []), ...(statusUpdateRequested ? ["statuses"] : [])] } });
  return { conflict: false as const, game: record };
}

export async function quickUpdateGameStatus(
  ownerUserId: string,
  gameId: string,
  input: z.infer<typeof quickGameStatusSchema>,
  requestId: string = randomUUID()
) {
  const current = await getGame(ownerUserId, gameId);
  if (!current) return null;
  const statuses = gameStatusesAfterQuickAction(current.statuses, input.action);
  return updateGame(ownerUserId, gameId, {
    version: input.version,
    statuses,
    ...(input.action === "COMPLETE" ? { completedAt: input.completedAt ?? shanghaiIsoDate() } : {}),
    ...(input.action === "UNCOMPLETE" ? { completedAt: null } : {})
  }, requestId);
}

export async function quickUpdateGameWishlist(
  ownerUserId: string,
  gameId: string,
  input: z.infer<typeof quickGameWishlistSchema>,
  requestId: string = randomUUID()
) {
  const current = await getGame(ownerUserId, gameId);
  if (!current) return null;
  if (current.version !== input.version) return { conflict: true as const, current };
  const activePurchaseList = current.statuses.includes("TO_BUY") || current.statuses.includes("WISHLIST");
  if (input.active && !activePurchaseList && !current.wishlistEligible) {
    throw new Error("GAME_WISHLIST_NOT_ELIGIBLE");
  }
  const futureRelease = Boolean(current.releaseDate && current.releaseDate > shanghaiIsoDate());
  const statuses = input.active
    ? uniqueGameStatuses([
      ...current.statuses.filter((status) => status === "COMPLETED" || status === "UNRELEASED"),
      ...(futureRelease ? ["UNRELEASED" as const] : []),
      "TO_BUY"
    ])
    : current.statuses.filter((status) => status !== "WISHLIST" && status !== "TO_BUY");
  return updateGame(ownerUserId, gameId, { version: input.version, statuses }, requestId);
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
    await reconcileWishlistForGames(transaction, ownerUserId, [gameId]);
    return { session, game };
  });
  await writeAudit({ actorUserId: ownerUserId, action: "game.play_session.create", entityType: "game", entityId: gameId, outcome: "SUCCESS", requestId, metadata: { minutes: input.minutes } });
  const game = await getGame(ownerUserId, gameId);
  return { ...result, game };
}
