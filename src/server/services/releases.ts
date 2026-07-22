import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { gameSearchVariants, normalizeGameSearchText } from "@/lib/game-search";
import { hasChineseCatalogText } from "@/lib/release-catalog-completeness";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { gameAcquisitions, gameReleaseEvents, games, platformLibraryItems, platformWishlistItems, steamLibraryItems } from "@/server/db/schema";

const platformFilter = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}, z.array(z.string().trim().min(1).max(100)).max(20).transform((values) => [...new Set(values)]).default([]));

export const releaseCalendarQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  platform: platformFilter
});

export const releaseCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  platform: platformFilter,
  readiness: z.enum(["ALL", "READY", "PENDING"]).default("ALL"),
  listState: z.enum(["ALL", "NOT_ADDED", "ADDED"]).default("ALL"),
  window: z.enum(["6M", "12M", "24M"]).default("24M"),
  sort: z.enum(["ready_date", "date_asc", "date_desc", "name_asc"]).default("ready_date"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(24)
});

export const selectReleaseCatalogEntrySchema = z.object({
  target: z.enum(["WISHLIST", "PLANNED"])
});

export function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const next = new Date(Date.UTC(year, monthNumber, 1));
  const last = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  return {
    start: first.toISOString().slice(0, 10),
    end: last.toISOString().slice(0, 10),
    firstWeekday: first.getUTCDay(),
    daysInMonth: last.getUTCDate()
  };
}

type ReleaseEvent = typeof gameReleaseEvents.$inferSelect;

export function releaseWorkIdentity(event: Pick<ReleaseEvent, "id" | "gameId" | "externalGameId" | "source">) {
  if (event.gameId) return `game:${event.gameId}`;
  if (event.source === "IGDB" && event.externalGameId) return `igdb:${event.externalGameId}`;
  return `event:${event.id}`;
}

function releaseIdentity(event: ReleaseEvent) {
  return `${event.platform}:${event.gameId ?? event.externalGameId ?? event.nameEn ?? event.nameZh}`.toLocaleLowerCase("en-US");
}

function regionPriority(region: string) {
  if (region === "GLOBAL") return 4;
  if (region === "ASIA") return 3;
  if (region === "JAPAN") return 2;
  return 1;
}

function shouldReplaceRelease(prior: ReleaseEvent, candidate: ReleaseEvent) {
  if (candidate.source !== "IGDB" && prior.source === "IGDB") return true;
  if (candidate.source === "IGDB" && prior.source !== "IGDB") return false;
  return regionPriority(candidate.region) > regionPriority(prior.region);
}

function dedupeReleaseEvents(events: ReleaseEvent[], includePrecision = false) {
  const deduped = new Map<string, ReleaseEvent>();
  for (const event of events) {
    const key = `${releaseIdentity(event)}${includePrecision ? `:${event.datePrecision}` : ""}`;
    const prior = deduped.get(key);
    if (!prior || shouldReplaceRelease(prior, event)) deduped.set(key, event);
  }
  return [...deduped.values()];
}

function groupReleaseWorks(events: ReleaseEvent[], partitionByDate = false) {
  const grouped = new Map<string, ReleaseEvent[]>();
  for (const event of dedupeReleaseEvents(events, true)) {
    const key = `${releaseWorkIdentity(event)}${partitionByDate ? `:${event.releaseDate}:${event.datePrecision}` : ""}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  return [...grouped.entries()].map(([groupKey, variants]) => ({ groupKey, variants }));
}

function catalogVariant(event: ReleaseEvent) {
  return {
    id: event.id,
    platform: event.platform,
    releaseDate: event.releaseDate,
    datePrecision: event.datePrecision,
    storeProvider: event.storeProvider,
    storeExternalGameId: event.storeExternalGameId,
    storeUrl: event.storeUrl,
    isSelectable: releaseCatalogSelectable(event)
  };
}

function primaryRelease(events: ReleaseEvent[]) {
  return [...events].sort((left, right) => {
    const selectable = Number(releaseCatalogSelectable(right)) - Number(releaseCatalogSelectable(left));
    if (selectable) return selectable;
    const completeness = releaseCatalogMissingFields(left).length - releaseCatalogMissingFields(right).length;
    if (completeness) return completeness;
    return left.releaseDate.localeCompare(right.releaseDate) || left.platform.localeCompare(right.platform);
  })[0];
}

const catalogFieldLabels = {
  nameZh: "中文名",
  nameEn: "英文名",
  coverUrl: "封面",
  storeUrl: "平台商店链接",
  storeIdentity: "平台游戏身份",
  summaryZh: "中文简介",
  summaryEn: "英文简介",
  developers: "开发商",
  publishers: "发行商",
  genresZh: "中文类型",
  genresEn: "英文类型"
} as const;

export function releaseCatalogMissingFields(event: Pick<ReleaseEvent,
  "nameZh" | "nameEn" | "coverUrl" | "storeUrl" | "storeProvider" | "storeExternalGameId"
  | "summaryZh" | "summaryEn" | "developers" | "publishers" | "genresZh" | "genresEn"
>) {
  const missing: Array<keyof typeof catalogFieldLabels> = [];
  if (!event.nameZh.trim()) missing.push("nameZh");
  if (!event.nameEn?.trim()) missing.push("nameEn");
  if (!event.coverUrl) missing.push("coverUrl");
  if (!event.storeUrl) missing.push("storeUrl");
  if (!event.storeProvider || !event.storeExternalGameId) missing.push("storeIdentity");
  if (!hasChineseCatalogText(event.summaryZh)) missing.push("summaryZh");
  if (!event.summaryEn?.trim()) missing.push("summaryEn");
  if (!event.developers.length) missing.push("developers");
  if (!event.publishers.length) missing.push("publishers");
  if (!event.genresZh.length) missing.push("genresZh");
  if (!event.genresEn.length) missing.push("genresEn");
  return missing;
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

type ReleaseCatalogSearchable = Pick<ReleaseEvent,
  "nameZh" | "nameEn" | "platform" | "developers" | "publishers" | "genresZh" | "genresEn"
>;

function catalogSearchValues(event: ReleaseCatalogSearchable) {
  return [
    event.nameZh,
    event.nameEn,
    event.platform,
    ...event.developers,
    ...event.publishers,
    ...event.genresZh,
    ...event.genresEn
  ].filter((value): value is string => Boolean(value?.trim()));
}

const releaseSearchAliasGroups = [
  ["艾恩格朗特", "艾恩葛朗特", "aincrad"]
] as const;

function normalizedSearchVariants(value: string) {
  return [...new Set(gameSearchVariants(value).map(normalizeGameSearchText).filter(Boolean))];
}

function fuzzyDistanceLimit(length: number) {
  if (length < 3) return 0;
  if (length <= 6) return 1;
  if (length <= 12) return 2;
  return 3;
}

function boundedEditDistance(left: string, right: string, limit: number) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function approximateSubstringDistance(haystack: string, needle: string) {
  const limit = fuzzyDistanceLimit(needle.length);
  if (!limit || !haystack || !needle) return null;
  const shortest = Math.max(1, needle.length - limit);
  const longest = Math.min(haystack.length, needle.length + limit);
  let best = limit + 1;
  for (let length = shortest; length <= longest; length += 1) {
    for (let start = 0; start + length <= haystack.length; start += 1) {
      best = Math.min(best, boundedEditDistance(haystack.slice(start, start + length), needle, limit));
      if (best === 0) return 0;
    }
  }
  return best <= limit ? best : null;
}

function aliasGroupMatchesQuery(group: readonly string[], queries: readonly string[]) {
  const aliases = group.flatMap(normalizedSearchVariants);
  return queries.some((query) => {
    const shortAliasQuery = query.length >= 2 && aliases.some((alias) => alias.includes(query));
    if (shortAliasQuery) return true;
    const limit = fuzzyDistanceLimit(query.length);
    return Boolean(limit) && aliases.some((alias) => boundedEditDistance(alias, query, limit) <= limit);
  });
}

function normalizedSearchTerms(rawQuery: string) {
  const queries = normalizedSearchVariants(rawQuery);
  if (!queries.length) return [];
  const aliasGroup = releaseSearchAliasGroups.find((group) => aliasGroupMatchesQuery(group, queries));
  return aliasGroup
    ? [...new Set([...queries, ...aliasGroup.flatMap(normalizedSearchVariants)])]
    : queries;
}

function releaseCatalogSearchRelevance(event: ReleaseCatalogSearchable, rawQuery: string) {
  const terms = normalizedSearchTerms(rawQuery);
  if (!terms.length) return 0;
  const values = catalogSearchValues(event).flatMap(normalizedSearchVariants);
  let best = 0;
  for (const term of terms) {
    for (const value of values) {
      if (value === term) best = Math.max(best, 120);
      else if (value.startsWith(term)) best = Math.max(best, 110);
      else if (value.includes(term)) best = Math.max(best, 100);
      else {
        const distance = approximateSubstringDistance(value, term);
        if (distance !== null) best = Math.max(best, 80 - distance);
      }
    }
  }
  return best;
}

export function releaseCatalogMatchesQuery(event: ReleaseCatalogSearchable, rawQuery: string) {
  return !rawQuery.trim() || releaseCatalogSearchRelevance(event, rawQuery) > 0;
}

export function releaseCatalogSelectable(
  event: Pick<ReleaseEvent, "storeProvider" | "storeExternalGameId">
): event is { storeProvider: "STEAM" | "PLAYSTATION" | "NINTENDO"; storeExternalGameId: string } {
  return (event.storeProvider === "STEAM" || event.storeProvider === "PLAYSTATION" || event.storeProvider === "NINTENDO")
    && Boolean(event.storeExternalGameId?.trim());
}

function wishlistForRelease(event: ReleaseEvent, items: Array<typeof platformWishlistItems.$inferSelect>) {
  return items.find((item) => (event.gameId && item.matchedGameId === event.gameId)
    || (event.storeProvider === item.provider && event.storeExternalGameId === item.externalGameId)
    || (event.source === "IGDB" && event.externalGameId && item.rawMetadata?.igdbGameId === event.externalGameId)) ?? null;
}

export async function listReleaseCatalog(ownerUserId: string, input: z.infer<typeof releaseCatalogQuerySchema>) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const months = input.window === "6M" ? 6 : input.window === "12M" ? 12 : 24;
  const to = addMonths(now, months).toISOString().slice(0, 10);
  const conditions = [
    eq(gameReleaseEvents.ownerUserId, ownerUserId),
    eq(gameReleaseEvents.source, "IGDB"),
    like(gameReleaseEvents.dedupeKey, "catalog:igdb:release:%"),
    gte(gameReleaseEvents.releaseDate, from),
    lte(gameReleaseEvents.releaseDate, to)
  ];
  if (input.platform.length) conditions.push(inArray(gameReleaseEvents.platform, input.platform));
  const [rawEvents, wishlisted] = await Promise.all([
    db.select().from(gameReleaseEvents).where(and(...conditions))
      .orderBy(asc(gameReleaseEvents.releaseDate), asc(gameReleaseEvents.nameZh)),
    db.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, ownerUserId),
      eq(platformWishlistItems.isActive, true)
    ))
  ]);
  const decorated = groupReleaseWorks(rawEvents).map(({ groupKey, variants: releaseVariants }) => {
    const event = primaryRelease(releaseVariants);
    const missingFields = releaseCatalogMissingFields(event);
    const wishlist = releaseVariants.map((variant) => wishlistForRelease(variant, wishlisted)).find(Boolean) ?? null;
    const variants = releaseVariants.map(catalogVariant).sort((left, right) => left.platform.localeCompare(right.platform));
    const searchRelevance = input.q
      ? Math.max(...releaseVariants.map((variant) => releaseCatalogSearchRelevance(variant, input.q)))
      : 0;
    return {
      ...event,
      groupKey,
      variants,
      platforms: [...new Set(releaseVariants.map((variant) => variant.platform))],
      releaseDates: [...new Set(releaseVariants.map((variant) => variant.releaseDate))].sort(),
      missingFields,
      missingLabels: missingFields.map((field) => catalogFieldLabels[field]),
      isComplete: missingFields.length === 0,
      isSelectable: variants.some((variant) => variant.isSelectable),
      wishlistItemId: wishlist?.id ?? null,
      planOrder: wishlist?.planOrder ?? null,
      listState: wishlist ? "ADDED" as const : "NOT_ADDED" as const,
      searchRelevance
    };
  });
  const counts = {
    total: decorated.length,
    ready: decorated.filter((event) => event.isComplete).length,
    selectable: decorated.filter((event) => event.isSelectable).length,
    pending: decorated.filter((event) => !event.isComplete).length,
    added: decorated.filter((event) => event.listState === "ADDED").length
  };
  const filtered = decorated.filter((event) => {
    if (input.q && event.searchRelevance <= 0) return false;
    if (input.readiness === "READY" && !event.isComplete) return false;
    if (input.readiness === "PENDING" && event.isComplete) return false;
    if (input.listState !== "ALL" && event.listState !== input.listState) return false;
    return true;
  });
  filtered.sort((left, right) => {
    if (input.q) {
      const relevance = right.searchRelevance - left.searchRelevance;
      if (relevance) return relevance;
    }
    if (input.sort === "ready_date" && left.isComplete !== right.isComplete) return left.isComplete ? -1 : 1;
    if (input.sort === "date_desc") return right.releaseDate.localeCompare(left.releaseDate) || left.nameZh.localeCompare(right.nameZh, "zh-CN");
    if (input.sort === "name_asc") return left.nameZh.localeCompare(right.nameZh, "zh-CN") || left.releaseDate.localeCompare(right.releaseDate);
    return left.releaseDate.localeCompare(right.releaseDate) || left.nameZh.localeCompare(right.nameZh, "zh-CN");
  });
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / input.pageSize));
  const page = Math.min(input.page, pageCount);
  const items = filtered.slice((page - 1) * input.pageSize, page * input.pageSize);
  const latestFetchedAt = rawEvents.reduce<Date | null>((latest, event) => !latest || event.fetchedAt > latest ? event.fetchedAt : latest, null);
  return { items, total, page, pageCount, pageSize: input.pageSize, counts, from, to, latestFetchedAt };
}

function hasLibraryFact(game: typeof games.$inferSelect, ownedGameIds: Set<string>) {
  return game.ownershipStatus === "OWNED"
    || ownedGameIds.has(game.id)
    || (game.playtimeMinutesManual ?? 0) > 0
    || game.playtimeMinutesSynced > 0
    || game.lastPlayedAt !== null
    || game.firstObservedPlayedAt !== null;
}

export async function selectReleaseCatalogEntry(
  ownerUserId: string,
  eventId: string,
  input: z.infer<typeof selectReleaseCatalogEntrySchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerUserId}))`);
    const [event] = await transaction.select().from(gameReleaseEvents).where(and(
      eq(gameReleaseEvents.id, eventId),
      eq(gameReleaseEvents.ownerUserId, ownerUserId)
    )).for("update");
    if (!event) return { missing: true as const };
    if (!releaseCatalogSelectable(event)) {
      return { incomplete: true as const, missingFields: ["storeIdentity"], missingLabels: [catalogFieldLabels.storeIdentity] };
    }
    if (event.gameId) {
      const [game] = await transaction.select().from(games).where(and(
        eq(games.id, event.gameId),
        eq(games.ownerUserId, ownerUserId),
        isNull(games.deletedAt)
      )).limit(1);
      if (game) {
        const [acquisitions, steamOwned, platformOwned] = await Promise.all([
          transaction.select({ gameId: gameAcquisitions.gameId }).from(gameAcquisitions).where(and(
            eq(gameAcquisitions.ownerUserId, ownerUserId), eq(gameAcquisitions.gameId, game.id), eq(gameAcquisitions.isOwned, true)
          )),
          transaction.select({ gameId: steamLibraryItems.matchedGameId }).from(steamLibraryItems).where(and(
            eq(steamLibraryItems.ownerUserId, ownerUserId), eq(steamLibraryItems.matchedGameId, game.id), eq(steamLibraryItems.isOwned, true), eq(steamLibraryItems.licenseType, "OWNED")
          )),
          transaction.select({ gameId: platformLibraryItems.matchedGameId }).from(platformLibraryItems).where(and(
            eq(platformLibraryItems.ownerUserId, ownerUserId), eq(platformLibraryItems.matchedGameId, game.id), eq(platformLibraryItems.isOwned, true)
          ))
        ]);
        const ownedIds = new Set([
          ...acquisitions.map((row) => row.gameId),
          ...steamOwned.map((row) => row.gameId).filter((id): id is string => Boolean(id)),
          ...platformOwned.map((row) => row.gameId).filter((id): id is string => Boolean(id))
        ]);
        if (hasLibraryFact(game, ownedIds)) return { inLibrary: true as const, gameId: game.id };
      }
    }
    const [current] = await transaction.select().from(platformWishlistItems).where(and(
      eq(platformWishlistItems.ownerUserId, ownerUserId),
      or(
        and(eq(platformWishlistItems.provider, event.storeProvider), eq(platformWishlistItems.externalGameId, event.storeExternalGameId!)),
        event.gameId ? eq(platformWishlistItems.matchedGameId, event.gameId) : sql`false`,
        event.source === "IGDB" && event.externalGameId
          ? sql`${platformWishlistItems.rawMetadata} ->> 'igdbGameId' = ${event.externalGameId}`
          : sql`false`
      )
    )).orderBy(asc(platformWishlistItems.createdAt)).limit(1).for("update");
    const planOrder = null;
    const now = new Date();
    const rawMetadata = {
      source: "RELEASE_CATALOG",
      catalogEventId: event.id,
      igdbGameId: event.externalGameId,
      nameZh: event.nameZh,
      nameEn: event.nameEn,
      summaryZh: event.summaryZh,
      summaryEn: event.summaryEn,
      developers: event.developers,
      publishers: event.publishers,
      genresZh: event.genresZh,
      genresEn: event.genresEn,
      platformVariants: (await transaction.select().from(gameReleaseEvents).where(and(
        eq(gameReleaseEvents.ownerUserId, ownerUserId),
        eq(gameReleaseEvents.source, event.source),
        event.gameId
          ? eq(gameReleaseEvents.gameId, event.gameId)
          : event.externalGameId
            ? eq(gameReleaseEvents.externalGameId, event.externalGameId)
            : eq(gameReleaseEvents.id, event.id)
      ))).map(catalogVariant)
    };
    let saved: typeof platformWishlistItems.$inferSelect | undefined;
    if (current) {
      [saved] = await transaction.update(platformWishlistItems).set({
        provider: event.storeProvider,
        externalGameId: event.storeExternalGameId!,
        name: event.nameEn?.trim() || event.nameZh,
        planOrder,
        platform: event.platform,
        coverUrl: event.coverUrl,
        releaseDate: event.releaseDate,
        releaseDatePrecision: event.datePrecision,
        storeUrl: event.storeUrl,
        matchedGameId: event.gameId,
        isActive: true,
        rawMetadata,
        lastSeenAt: now,
        updatedAt: now
      }).where(eq(platformWishlistItems.id, current.id)).returning();
    } else {
      [saved] = await transaction.insert(platformWishlistItems).values({
        ownerUserId,
        provider: event.storeProvider,
        externalGameId: event.storeExternalGameId!,
        name: event.nameEn?.trim() || event.nameZh,
        planOrder,
        addedAt: now,
        platform: event.platform,
        coverUrl: event.coverUrl,
        releaseDate: event.releaseDate,
        releaseDatePrecision: event.datePrecision,
        storeUrl: event.storeUrl,
        matchedGameId: event.gameId,
        isActive: true,
        rawMetadata,
        lastSeenAt: now,
        updatedAt: now
      }).returning();
    }
    if (!saved) throw new Error("RELEASE_CATALOG_SELECTION_WRITE_FAILED");
    return { item: saved, reused: Boolean(current?.isActive), target: input.target };
  });
  if ("item" in result && result.item) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "release_catalog.select",
      entityType: "release_catalog_entry",
      entityId: eventId,
      outcome: "SUCCESS",
      requestId,
      metadata: { wishlistItemId: result.item.id, target: result.target, reused: result.reused }
    });
  }
  return result;
}

export async function listReleaseCalendar(
  ownerUserId: string,
  input: z.infer<typeof releaseCalendarQuerySchema>
) {
  const bounds = monthBounds(input.month);
  const conditions = [
    eq(gameReleaseEvents.ownerUserId, ownerUserId),
    eq(gameReleaseEvents.datePrecision, "DAY"),
    gte(gameReleaseEvents.releaseDate, bounds.start),
    lte(gameReleaseEvents.releaseDate, bounds.end)
  ];
  if (input.platform.length) conditions.push(inArray(gameReleaseEvents.platform, input.platform));
  const rawEvents = await db.select().from(gameReleaseEvents)
    .where(and(...conditions))
    .orderBy(asc(gameReleaseEvents.releaseDate), asc(gameReleaseEvents.nameZh));
  const approximateConditions = [
    eq(gameReleaseEvents.ownerUserId, ownerUserId),
    ne(gameReleaseEvents.datePrecision, "DAY"),
    gte(gameReleaseEvents.releaseDate, `${input.month.slice(0, 4)}-01-01`),
    lte(gameReleaseEvents.releaseDate, `${input.month.slice(0, 4)}-12-31`)
  ];
  if (input.platform.length) approximateConditions.push(inArray(gameReleaseEvents.platform, input.platform));
  const [approximate, wishlisted] = await Promise.all([
    db.select().from(gameReleaseEvents).where(and(...approximateConditions)).orderBy(asc(gameReleaseEvents.releaseDate), asc(gameReleaseEvents.nameZh)),
    db.select().from(platformWishlistItems).where(and(
        eq(platformWishlistItems.ownerUserId, ownerUserId),
        eq(platformWishlistItems.isActive, true)
      ))
  ]);
  const wishedExternal = new Set(wishlisted.map((item) => item.externalGameId));
  const wishedGames = new Set(wishlisted.map((item) => item.matchedGameId).filter((value): value is string => Boolean(value)));
  const wishedIgdb = new Set(wishlisted.map((item) => typeof item.rawMetadata?.igdbGameId === "string" ? item.rawMetadata.igdbGameId : null).filter((value): value is string => Boolean(value)));
  const decorate = (events: ReleaseEvent[]) => {
    const event = primaryRelease(events);
    const missingFields = releaseCatalogMissingFields(event);
    return {
      ...event,
      groupKey: releaseWorkIdentity(event),
      variants: events.map(catalogVariant),
      platforms: [...new Set(events.map((variant) => variant.platform))],
      isWishlisted: events.some((variant) => wishedGames.has(variant.gameId ?? "")
        || wishedExternal.has(variant.storeExternalGameId ?? "")
        || wishedIgdb.has(variant.externalGameId ?? "")),
      isComplete: missingFields.length === 0,
      isSelectable: events.some(releaseCatalogSelectable)
    };
  };
  const exact = groupReleaseWorks(rawEvents, true).map((group) => decorate(group.variants));
  const trackedApproximate = groupReleaseWorks(approximate, true)
    .map((group) => decorate(group.variants))
    .filter((event) => Boolean(event.gameId) || event.isWishlisted);
  return {
    ...bounds,
    month: input.month,
    platforms: input.platform,
    events: exact,
    approximate: trackedApproximate,
    wishlistCount: wishlisted.length
  };
}
