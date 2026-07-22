import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { acquisitionChannelValues, defaultScenarioForPlatform, type AcquisitionChannel } from "@/lib/play-planning";
import { providerForPlatform as engineProviderForPlatform } from "@/lib/game-state-engine";
import { gameGenreValues, mapExternalGenres } from "@/lib/game-genres";
import { dualsenseProfileMatrix, rayTracingProfileFromGame, type DualsenseProfile } from "@/lib/game-hardware";
import { advisePurchase, type PurchaseAdvice } from "@/lib/purchase-advisor";
import { getHardwareProfile } from "@/server/services/preferences";
import { gameSearchVariants, normalizeGameSearchAliases, normalizeGameSearchText } from "@/lib/game-search";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { reconcileWishlistForGames } from "@/server/services/game-wishlist";
import { nextPlanQueueOrder } from "@/server/services/play-planning";
import { auditLogs, gameAcquisitions, gameDualsenseProfiles, gamePlayPlans, gameReleaseEvents, games, platformWishlistItems } from "@/server/db/schema";

const providerSchema = z.enum(["STEAM", "PLAYSTATION", "NINTENDO"]);
const nullableUrl = z.string().trim().max(2048).url().refine((value) => /^https?:\/\//i.test(value), "链接只支持 HTTP/HTTPS").nullable();
const nullableDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const wishlistQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  provider: providerSchema.optional(),
  genre: z.enum(gameGenreValues).optional()
});

export const createWishlistItemSchema = z.object({
  name: z.string().trim().min(1).max(300),
  provider: providerSchema,
  externalGameId: z.string().trim().min(1).max(200).nullable().optional(),
  platform: z.string().trim().min(1).max(100).nullable().optional(),
  storeUrl: nullableUrl.optional(),
  coverUrl: nullableUrl.optional(),
  releaseDate: nullableDate.optional(),
  releaseDatePrecision: z.enum(["DAY", "MONTH", "QUARTER", "YEAR"]).default("DAY"),
  planOrder: z.number().int().min(1).max(9999).nullable().optional()
});

export const updateWishlistPlanSchema = z.object({
  planned: z.boolean(),
  planOrder: z.number().int().min(1).max(9999).optional()
});

export const wishlistPlatformSelectionSchema = z.object({
  provider: providerSchema,
  platform: z.string().trim().min(1).max(100),
  externalGameId: z.string().trim().min(1).max(200).nullable().optional(),
  storeUrl: nullableUrl.optional(),
  catalogEventId: z.string().uuid().nullable().optional()
}).superRefine((value, context) => {
  const expected = providerForPlatform(value.platform);
  if (expected !== value.provider) context.addIssue({ code: "custom", path: ["provider"], message: "平台与来源不一致" });
});

export const acquireWishlistItemSchema = z.object({
  channel: z.enum(acquisitionChannelValues),
  selection: wishlistPlatformSelectionSchema.optional()
});

export class WishlistAcquireError extends Error {
  constructor(public code: "WISHLIST_INACTIVE" | "WISHLIST_CONVERSION_FAILED", message: string) {
    super(message);
  }
}

type WishlistTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalizeTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function providerForPlatform(platform: string): z.infer<typeof providerSchema> {
  return engineProviderForPlatform(platform);
}

function wishlistSearchCondition(query: string) {
  const pattern = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const normalized = normalizeGameSearchText(query);
  const normalizedPattern = `%${normalized.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const threshold = normalized.length <= 4 ? 0.32 : normalized.length <= 7 ? 0.36 : 0.4;
  const fuzzy = normalized.length >= 3
    ? sql`or similarity(lower(${platformWishlistItems.name}), lower(${query})) >= ${threshold}
        or word_similarity(lower(${query}), lower(${platformWishlistItems.name})) >= ${threshold}
        or similarity(regexp_replace(lower(${platformWishlistItems.name}), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g'), ${normalized}) >= ${threshold}`
    : sql``;
  return sql`(
    ${platformWishlistItems.name} ilike ${pattern} escape '\\'
    or regexp_replace(lower(${platformWishlistItems.name}), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g') ilike ${normalizedPattern} escape '\\'
    or coalesce(${platformWishlistItems.rawMetadata}->>'nameZh', '') ilike ${pattern} escape '\\'
    or regexp_replace(lower(coalesce(${platformWishlistItems.rawMetadata}->>'nameZh', '')), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g') ilike ${normalizedPattern} escape '\\'
    ${fuzzy}
    or exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(${platformWishlistItems.rawMetadata}->'aliases') = 'array'
          then ${platformWishlistItems.rawMetadata}->'aliases' else '[]'::jsonb end
      ) as alias(value)
      where alias.value ilike ${pattern} escape '\\'
        or regexp_replace(lower(alias.value), '[^[:alnum:]一-龥ぁ-んァ-ヶー가-힣]+', '', 'g') ilike ${normalizedPattern} escape '\\'
    )
  )`;
}

function steamAppId(input: z.infer<typeof createWishlistItemSchema>) {
  const explicit = input.externalGameId?.match(/^\d+$/)?.[0];
  if (explicit) return explicit;
  return input.storeUrl?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] ?? null;
}

function providerMatchesGame(provider: string, game: typeof games.$inferSelect) {
  const platform = `${game.platform ?? ""} ${game.platformSource ?? ""}`.toUpperCase();
  if (provider === "STEAM") return Boolean(game.steamAppId) || platform.includes("STEAM");
  if (provider === "PLAYSTATION") return platform.includes("PLAYSTATION") || /(^|\s)PS[345](\s|$)/.test(platform);
  return platform.includes("NINTENDO") || platform.includes("SWITCH");
}

function hasLibraryFact(game: typeof games.$inferSelect) {
  return game.ownershipStatus === "OWNED"
    || (game.playtimeMinutesManual ?? 0) > 0
    || game.playtimeMinutesSynced > 0
    || game.lastPlayedAt !== null
    || game.firstObservedPlayedAt !== null;
}

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const storedPlatformVariantSchema = z.object({
  id: z.string().uuid(),
  platform: z.string().min(1).max(100),
  releaseDate: z.string(),
  datePrecision: z.string(),
  storeProvider: providerSchema.nullable(),
  storeExternalGameId: z.string().nullable(),
  storeUrl: z.string().nullable(),
  isSelectable: z.boolean()
});

function wishlistPlatformVariants(item: typeof platformWishlistItems.$inferSelect) {
  const parsed = z.array(storedPlatformVariantSchema).safeParse(item.rawMetadata?.platformVariants);
  if (!parsed.success) return [];
  return parsed.data.map((variant) => ({
    provider: variant.storeProvider,
    platform: variant.platform,
    externalGameId: variant.storeExternalGameId,
    storeUrl: variant.storeUrl,
    catalogEventId: variant.id,
    releaseDate: variant.releaseDate,
    isSelectable: variant.isSelectable
  }));
}

function databaseInteger(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
}

function wishlistGameNames(item: typeof platformWishlistItems.$inferSelect) {
  const localized = stringMetadata(item.rawMetadata, "nameZh");
  const english = stringMetadata(item.rawMetadata, "nameEn");
  const primary = (localized ?? item.name).trim().slice(0, 200);
  const secondary = english && normalizeTitle(english) !== normalizeTitle(primary)
    ? english.slice(0, 200)
    : localized && normalizeTitle(item.name) !== normalizeTitle(primary)
      ? item.name.slice(0, 200)
      : null;
  const metadataAliases = Array.isArray(item.rawMetadata.aliases)
    ? item.rawMetadata.aliases.filter((value): value is string => typeof value === "string")
    : [];
  return {
    primary,
    secondary,
    aliases: normalizeGameSearchAliases([item.name, localized ?? "", english ?? "", ...metadataAliases].filter(Boolean))
  };
}

function metadataStringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function wishlistItemGenres(item: Pick<typeof platformWishlistItems.$inferSelect, "rawMetadata">) {
  const names = [
    ...metadataStringArray(item.rawMetadata, "genresZh"),
    ...metadataStringArray(item.rawMetadata, "genresEn")
  ];
  const mapped = mapExternalGenres(names);
  return mapped.primaryGenre ? [mapped.primaryGenre, ...mapped.subGenres] : mapped.subGenres;
}

function acquisitionPlatform(item: typeof platformWishlistItems.$inferSelect) {
  const value = item.platform?.trim() || item.provider;
  return value.length <= 60 ? value : item.provider;
}

function acquisitionOfflineCapable(item: typeof platformWishlistItems.$inferSelect) {
  if (item.provider === "PLAYSTATION") return false;
  return item.provider === "STEAM" || item.provider === "NINTENDO";
}

async function exactWishlistGame(
  transaction: WishlistTransaction,
  ownerUserId: string,
  item: typeof platformWishlistItems.$inferSelect
) {
  if (item.matchedGameId) {
    const [matched] = await transaction.select().from(games).where(and(
      eq(games.id, item.matchedGameId),
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt)
    )).for("update");
    if (matched) return matched;
  }
  const appId = item.provider === "STEAM" ? databaseInteger(item.externalGameId) : null;
  if (appId !== null) {
    const [steamMatch] = await transaction.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      eq(games.steamAppId, appId),
      isNull(games.deletedAt)
    )).for("update");
    if (steamMatch) return steamMatch;
  }
  const rawIgdbId = stringMetadata(item.rawMetadata, "igdbGameId");
  const igdbGameId = databaseInteger(rawIgdbId);
  if (igdbGameId !== null) {
    const [igdbMatch] = await transaction.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      eq(games.igdbGameId, igdbGameId),
      isNull(games.deletedAt)
    )).for("update");
    if (igdbMatch) return igdbMatch;
  }
  const names = wishlistGameNames(item);
  const exactNames = [...new Set([item.name, names.primary, names.secondary].filter((value): value is string => Boolean(value)))];
  const candidates = await transaction.select().from(games).where(and(
    eq(games.ownerUserId, ownerUserId),
    isNull(games.deletedAt),
    or(...exactNames.flatMap((name) => [
      sql`lower(${games.nameZh}) = lower(${name})`,
      sql`lower(coalesce(${games.nameEn}, '')) = lower(${name})`
    ]))!
  )).for("update");
  const matching = candidates.filter((game) => providerMatchesGame(item.provider, game)
    && exactNames.some((name) => normalizeTitle(game.nameZh) === normalizeTitle(name)
      || normalizeTitle(game.nameEn ?? "") === normalizeTitle(name)));
  return matching.length === 1 ? matching[0] : null;
}

async function materializeWishlistGame(
  transaction: WishlistTransaction,
  ownerUserId: string,
  item: typeof platformWishlistItems.$inferSelect
) {
  const names = wishlistGameNames(item);
  const numericIgdbId = stringMetadata(item.rawMetadata, "igdbGameId");
  const igdbGameId = databaseInteger(numericIgdbId);
  const steamAppId = item.provider === "STEAM" ? databaseInteger(item.externalGameId) : null;
  const [created] = await transaction.insert(games).values({
    ownerUserId,
    nameZh: names.primary,
    nameEn: names.secondary,
    searchAliases: names.aliases,
    nameEnSource: item.provider,
    platform: acquisitionPlatform(item),
    platformSource: item.provider,
    releaseDate: item.releaseDate,
    releaseDateSource: item.provider,
    coverUrl: item.coverUrl,
    coverUrlSource: item.coverUrl ? item.provider : null,
    steamAppId,
    igdbGameId
  }).returning();
  return created;
}

export async function listWishlist(ownerUserId: string, input: z.infer<typeof wishlistQuerySchema>) {
  const conditions = [eq(platformWishlistItems.ownerUserId, ownerUserId), eq(platformWishlistItems.isActive, true)];
  if (input.provider) conditions.push(eq(platformWishlistItems.provider, input.provider));
  if (input.q) conditions.push(or(...gameSearchVariants(input.q).map(wishlistSearchCondition))!);
  const where = and(...conditions);
  const [items, [total]] = await Promise.all([
    db.select().from(platformWishlistItems).where(where)
      .orderBy(sql`${platformWishlistItems.planOrder} ASC NULLS LAST`, asc(platformWishlistItems.releaseDate), asc(platformWishlistItems.name)),
    db.select({ value: count() }).from(platformWishlistItems).where(where)
  ]);
  const matchedGameIds = [...new Set(items.map((item) => item.matchedGameId).filter((value): value is string => value !== null))];
  const [matchedGames, zeroCostRows, dualsenseRows, hardware] = await Promise.all([
    matchedGameIds.length
      ? db.select().from(games).where(and(eq(games.ownerUserId, ownerUserId), inArray(games.id, matchedGameIds)))
      : Promise.resolve([]),
    matchedGameIds.length
      ? db.select({ gameId: gameAcquisitions.gameId, channel: gameAcquisitions.channel })
        .from(gameAcquisitions)
        .where(and(
          eq(gameAcquisitions.ownerUserId, ownerUserId),
          inArray(gameAcquisitions.gameId, matchedGameIds),
          eq(gameAcquisitions.isOwned, true),
          eq(gameAcquisitions.availability, "AVAILABLE"),
          inArray(gameAcquisitions.channel, ["SUBSCRIPTION", "FAMILY_SHARED"])
        ))
      : Promise.resolve([]),
    matchedGameIds.length
      ? db.select({
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
        inArray(gameDualsenseProfiles.gameId, matchedGameIds)
      ))
      : Promise.resolve([]),
    getHardwareProfile(ownerUserId)
  ]);
  const gamesById = new Map(matchedGames.map((game) => [game.id, game]));
  const zeroCostByGame = new Map<string, AcquisitionChannel[]>();
  for (const row of zeroCostRows) {
    if (!row.channel) continue;
    const channels = zeroCostByGame.get(row.gameId) ?? [];
    if (!channels.includes(row.channel)) channels.push(row.channel);
    zeroCostByGame.set(row.gameId, channels);
  }
  const dualsenseByGame = new Map<string, DualsenseProfile[]>();
  for (const { gameId, ...profile } of dualsenseRows) {
    dualsenseByGame.set(gameId, [...(dualsenseByGame.get(gameId) ?? []), profile]);
  }
  const serialized = items.map((item) => {
    const variants = wishlistPlatformVariants(item);
    const matchedGame = item.matchedGameId ? gamesById.get(item.matchedGameId) ?? null : null;
    const purchaseAdvice: PurchaseAdvice | null = matchedGame
      ? advisePurchase({
        dualsenseProfiles: dualsenseProfileMatrix(dualsenseByGame.get(matchedGame.id), matchedGame),
        rayTracing: rayTracingProfileFromGame(matchedGame),
        platforms: [item.platform, matchedGame.platform, ...variants.map((variant) => variant.platform)],
        zeroCostChannels: zeroCostByGame.get(matchedGame.id) ?? [],
        hardware
      })
      : null;
    return {
      ...item,
      displayName: typeof item.rawMetadata?.nameZh === "string" ? item.rawMetadata.nameZh : item.name,
      source: item.rawMetadata?.source === "MANUAL" ? "MANUAL" as const : "PLATFORM" as const,
      platformVariants: variants,
      genres: wishlistItemGenres(item),
      purchaseAdvice
    };
  });
  const filtered = input.genre ? serialized.filter((item) => item.genres.includes(input.genre!)) : serialized;
  return {
    items: filtered,
    total: input.genre ? filtered.length : total.value
  };
}

export async function createWishlistItem(
  ownerUserId: string,
  input: z.infer<typeof createWishlistItemSchema>,
  requestId: string = randomUUID()
) {
  const appId = input.provider === "STEAM" ? steamAppId(input) : null;
  const externalGameId = input.externalGameId ?? appId ?? `manual:${randomUUID()}`;
  const candidates = await db.select().from(games).where(and(
    eq(games.ownerUserId, ownerUserId),
    isNull(games.deletedAt),
    appId
      ? or(eq(games.steamAppId, Number(appId)), sql`lower(${games.nameZh}) = lower(${input.name})`, sql`lower(${games.nameEn}) = lower(${input.name})`)
      : or(sql`lower(${games.nameZh}) = lower(${input.name})`, sql`lower(${games.nameEn}) = lower(${input.name})`)
  ));
  const matching = candidates.filter((game) => providerMatchesGame(input.provider, game)
    && (appId ? game.steamAppId === Number(appId) || normalizeTitle(game.nameZh) === normalizeTitle(input.name) || normalizeTitle(game.nameEn ?? "") === normalizeTitle(input.name)
      : normalizeTitle(game.nameZh) === normalizeTitle(input.name) || normalizeTitle(game.nameEn ?? "") === normalizeTitle(input.name)));
  if (matching.some(hasLibraryFact)) throw new Error("WISHLIST_ALREADY_IN_LIBRARY");
  const matchedGame = matching.length === 1 ? matching[0] : null;
  const now = new Date();
  const item = await db.transaction(async (transaction) => {
    const [saved] = await transaction.insert(platformWishlistItems).values({
      ownerUserId,
      provider: input.provider,
      externalGameId,
      name: input.name,
      planOrder: input.planOrder ?? null,
      platform: input.platform ?? input.provider,
      coverUrl: input.coverUrl ?? null,
      releaseDate: input.releaseDate ?? null,
      releaseDatePrecision: input.releaseDatePrecision,
      storeUrl: input.storeUrl ?? null,
      matchedGameId: matchedGame?.id ?? null,
      isActive: true,
      rawMetadata: { source: "MANUAL" },
      lastSeenAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [platformWishlistItems.ownerUserId, platformWishlistItems.provider, platformWishlistItems.externalGameId],
      set: {
        name: input.name,
        ...(input.planOrder !== undefined ? { planOrder: input.planOrder } : {}),
        platform: input.platform ?? input.provider,
        coverUrl: input.coverUrl ?? null,
        releaseDate: input.releaseDate ?? null,
        releaseDatePrecision: input.releaseDatePrecision,
        storeUrl: input.storeUrl ?? null,
        matchedGameId: matchedGame?.id ?? null,
        isActive: true,
        rawMetadata: { source: "MANUAL" },
        lastSeenAt: now,
        updatedAt: now
      }
    }).returning();
    if (input.releaseDate) {
      await transaction.insert(gameReleaseEvents).values({
        ownerUserId,
        gameId: matchedGame?.id ?? null,
        source: "MANUAL",
        dedupeKey: `wishlist:manual:${saved.id}`,
        externalGameId,
        nameZh: input.name,
        nameEn: input.name,
        platform: input.platform ?? input.provider,
        releaseDate: input.releaseDate,
        datePrecision: input.releaseDatePrecision,
        storeUrl: input.storeUrl ?? null,
        coverUrl: input.coverUrl ?? null,
        fetchedAt: now,
        updatedAt: now
      }).onConflictDoUpdate({
        target: [gameReleaseEvents.ownerUserId, gameReleaseEvents.dedupeKey],
        set: {
          gameId: matchedGame?.id ?? null,
          nameZh: input.name,
          nameEn: input.name,
          platform: input.platform ?? input.provider,
          releaseDate: input.releaseDate,
          datePrecision: input.releaseDatePrecision,
          storeUrl: input.storeUrl ?? null,
          coverUrl: input.coverUrl ?? null,
          fetchedAt: now,
          updatedAt: now
        }
      });
    }
    return saved;
  });
  await writeAudit({
    actorUserId: ownerUserId,
    action: "wishlist.create",
    entityType: "wishlist_item",
    entityId: item.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { provider: input.provider, externalGameId, matchedGameId: matchedGame?.id ?? null }
  });
  return item;
}

export async function updateWishlistPlan(
  ownerUserId: string,
  itemId: string,
  input: z.infer<typeof updateWishlistPlanSchema>,
  requestId: string = randomUUID()
) {
  const item = await db.transaction(async (transaction) => {
    const [current] = await transaction.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.id, itemId),
      eq(platformWishlistItems.ownerUserId, ownerUserId),
      eq(platformWishlistItems.isActive, true)
    )).for("update");
    if (!current) return null;
    let planOrder: number | null = null;
    if (input.planned) {
      if (input.planOrder !== undefined) planOrder = input.planOrder;
      else {
        const [maximum] = await transaction.select({
          value: sql<number>`coalesce(max(${platformWishlistItems.planOrder}), 0)`
        }).from(platformWishlistItems).where(and(
          eq(platformWishlistItems.ownerUserId, ownerUserId),
          eq(platformWishlistItems.isActive, true)
        ));
        const next = Math.max(10, Math.ceil((Number(maximum?.value ?? 0) + 1) / 10) * 10);
        planOrder = Math.min(next, 9999);
      }
    }
    const [saved] = await transaction.update(platformWishlistItems).set({
      planOrder,
      updatedAt: new Date()
    }).where(eq(platformWishlistItems.id, itemId)).returning();
    return saved;
  });
  if (!item) return null;
  await writeAudit({
    actorUserId: ownerUserId,
    action: "wishlist.plan.update",
    entityType: "wishlist_item",
    entityId: item.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { planned: input.planned, planOrder: item.planOrder }
  });
  return item;
}

export async function acquireWishlistItem(
  ownerUserId: string,
  itemId: string,
  input: z.infer<typeof acquireWishlistItemSchema>,
  requestId: string = randomUUID()
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerUserId}))`);
    const [item] = await transaction.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.id, itemId),
      eq(platformWishlistItems.ownerUserId, ownerUserId)
    )).for("update");
    if (!item) return null;

    const externalAcquisitionId = `wishlist:${item.id}`;
    const [previousAcquisition] = await transaction.select().from(gameAcquisitions).where(and(
      eq(gameAcquisitions.ownerUserId, ownerUserId),
      eq(gameAcquisitions.source, "MANUAL"),
      eq(gameAcquisitions.externalAcquisitionId, externalAcquisitionId)
    )).limit(1);
    if (!item.isActive) {
      if (!previousAcquisition || item.matchedGameId !== previousAcquisition.gameId) {
        throw new WishlistAcquireError("WISHLIST_INACTIVE", "该愿望项已被移出或自动归档，请刷新后重试");
      }
      return {
        reused: true,
        gameId: previousAcquisition.gameId,
        acquisitionId: previousAcquisition.id,
        channel: previousAcquisition.channel as AcquisitionChannel,
        platform: previousAcquisition.platform,
        scenario: null,
        queueOrder: null
      };
    }

    const selectedProvider = input.selection?.provider ?? item.provider;
    const selectedPlatform = input.selection?.platform ?? item.platform ?? item.provider;
    const selectedExternalGameId = input.selection?.externalGameId
      ?? (selectedProvider === item.provider ? item.externalGameId : `manual-platform:${item.id}:${selectedProvider}`);
    const effectiveItem = {
      ...item,
      provider: selectedProvider,
      platform: selectedPlatform,
      externalGameId: selectedExternalGameId,
      storeUrl: input.selection?.storeUrl ?? item.storeUrl,
      rawMetadata: {
        ...item.rawMetadata,
        selectedPlatform: {
          provider: selectedProvider,
          platform: selectedPlatform,
          externalGameId: selectedExternalGameId,
          storeUrl: input.selection?.storeUrl ?? item.storeUrl,
          catalogEventId: input.selection?.catalogEventId ?? null
        }
      }
    };
    const currentGame = await exactWishlistGame(transaction, ownerUserId, effectiveItem)
      ?? await materializeWishlistGame(transaction, ownerUserId, effectiveItem);
    const now = new Date();
    const platform = acquisitionPlatform(effectiveItem);
    const [acquisition] = await transaction.insert(gameAcquisitions).values({
      ownerUserId,
      gameId: currentGame.id,
      source: "MANUAL",
      externalAcquisitionId,
      channel: input.channel,
      platform,
      availability: "AVAILABLE",
      offlineCapable: acquisitionOfflineCapable(effectiveItem),
      acquiredAt: now,
      isOwned: input.channel === "PHYSICAL" || input.channel === "SELF_PURCHASED",
      details: {
        label: "愿望单快捷入手",
        classificationMode: "WISHLIST_QUICK_ACQUIRE",
        manuallyClassified: true,
        wishlistItemId: item.id,
        provider: selectedProvider
      },
      lastConfirmedAt: now
    }).onConflictDoUpdate({
      target: [gameAcquisitions.ownerUserId, gameAcquisitions.source, gameAcquisitions.externalAcquisitionId],
      set: {
        gameId: currentGame.id,
        channel: input.channel,
        platform,
        availability: "AVAILABLE",
        offlineCapable: acquisitionOfflineCapable(effectiveItem),
        acquiredAt: now,
        isOwned: input.channel === "PHYSICAL" || input.channel === "SELF_PURCHASED",
        details: {
          label: "愿望单快捷入手",
          classificationMode: "WISHLIST_QUICK_ACQUIRE",
          manuallyClassified: true,
          wishlistItemId: item.id,
          provider: selectedProvider
        },
        lastConfirmedAt: now,
        updatedAt: now,
        version: sql`${gameAcquisitions.version} + 1`
      }
    }).returning();

    await transaction.update(platformWishlistItems).set({
      matchedGameId: currentGame.id,
      platform: selectedPlatform,
      storeUrl: input.selection?.storeUrl ?? item.storeUrl,
      updatedAt: now
    }).where(eq(platformWishlistItems.id, item.id));
    const rawCatalogEventId = input.selection?.catalogEventId ?? stringMetadata(item.rawMetadata, "catalogEventId");
    const catalogEventId = rawCatalogEventId && z.string().uuid().safeParse(rawCatalogEventId).success ? rawCatalogEventId : null;
    if (catalogEventId) {
      await transaction.update(gameReleaseEvents).set({ gameId: currentGame.id, updatedAt: now }).where(and(
        eq(gameReleaseEvents.id, catalogEventId),
        eq(gameReleaseEvents.ownerUserId, ownerUserId)
      ));
    }
    const transition = await reconcileWishlistForGames(transaction, ownerUserId, [currentGame.id], now);
    if (!transition.transitions.some((entry) => entry.gameId === currentGame.id && entry.to === "BACKLOG")) {
      throw new WishlistAcquireError("WISHLIST_CONVERSION_FAILED", "购入渠道已选择，但候玩池转换未完成");
    }
    const scenario = defaultScenarioForPlatform(platform, selectedProvider);
    const queueOrder = await nextPlanQueueOrder(transaction, ownerUserId, scenario);
    const [createdPlan] = await transaction.insert(gamePlayPlans).values({
      ownerUserId,
      gameId: currentGame.id,
      scenario,
      state: "QUEUED",
      acquisitionId: acquisition.id,
      completionGoal: "EXTRA",
      queueOrder
    }).onConflictDoNothing().returning({ id: gamePlayPlans.id, queueOrder: gamePlayPlans.queueOrder });
    await transaction.update(platformWishlistItems).set({
      rawMetadata: {
        ...effectiveItem.rawMetadata,
        quickAcquisition: {
          acquisitionId: acquisition.id,
          gameId: currentGame.id,
          channel: input.channel,
          platform,
          provider: selectedProvider,
          scenario,
          queueOrder: createdPlan?.queueOrder ?? null,
          convertedAt: now.toISOString()
        }
      },
      updatedAt: now
    }).where(eq(platformWishlistItems.id, item.id));
    await transaction.insert(auditLogs).values({
      actorUserId: ownerUserId,
      action: "wishlist.acquire",
      entityType: "wishlist_item",
      entityId: item.id,
      outcome: "SUCCESS",
      requestId,
      metadata: {
        gameId: currentGame.id,
        acquisitionId: acquisition.id,
        channel: input.channel,
        platform,
        provider: selectedProvider,
        scenario,
        queueOrder: createdPlan?.queueOrder ?? null
      }
    });
    return {
      reused: Boolean(previousAcquisition),
      gameId: currentGame.id,
      acquisitionId: acquisition.id,
      channel: input.channel,
      platform,
      scenario,
      queueOrder: createdPlan?.queueOrder ?? null
    };
  });
}

export async function removeWishlistItem(ownerUserId: string, itemId: string, requestId: string = randomUUID()) {
  const [item] = await db.update(platformWishlistItems).set({ isActive: false, updatedAt: new Date() }).where(and(
    eq(platformWishlistItems.id, itemId),
    eq(platformWishlistItems.ownerUserId, ownerUserId),
    eq(platformWishlistItems.isActive, true)
  )).returning();
  if (!item) return null;
  await writeAudit({
    actorUserId: ownerUserId,
    action: "wishlist.remove",
    entityType: "wishlist_item",
    entityId: item.id,
    outcome: "SUCCESS",
    requestId,
    metadata: { provider: item.provider, source: item.rawMetadata?.source ?? "PLATFORM" }
  });
  return item;
}
