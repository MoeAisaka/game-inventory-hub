import { and, asc, eq, gt, gte, isNotNull, isNull, like, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/lib/env";
import { mapExternalGenres } from "@/lib/game-genres";
import { db } from "@/server/db";
import { externalGameMappings, gameFieldLocks, gameReleaseEvents, games, syncJobs } from "@/server/db/schema";
import { fetchSteamStoreMetadata } from "@/server/integrations/steam-store";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string()
});

const searchResponse = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  first_release_date: z.number().int().positive().optional(),
  rating: z.number().min(0).max(100).optional(),
  rating_count: z.number().int().nonnegative().optional(),
  aggregated_rating: z.number().min(0).max(100).optional(),
  aggregated_rating_count: z.number().int().nonnegative().optional(),
  alternative_names: z.array(z.object({ name: z.string().min(1) })).optional(),
  cover: z.object({ url: z.string() }).optional(),
  release_dates: z.array(z.object({ date: z.number().int().positive().optional() })).optional()
}));

const timeResponse = z.array(z.object({
  game_id: z.number().int().positive(),
  hastily: z.number().int().nonnegative().optional(),
  normally: z.number().int().nonnegative().optional(),
  completely: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative().optional()
}));

const releaseCatalogResponse = z.array(z.object({
  id: z.number().int().positive(),
  date: z.number().int().positive(),
  date_format: z.number().int().nonnegative().optional(),
  human: z.string().optional(),
  region: z.number().int().nonnegative().optional(),
  platform: z.object({ id: z.number().int().positive(), name: z.string().min(1) }),
  game: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    hypes: z.number().int().nonnegative().optional(),
    total_rating_count: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
    alternative_names: z.array(z.object({ name: z.string().min(1) })).optional(),
    cover: z.object({ url: z.string() }).optional(),
    genres: z.array(z.object({ name: z.string().min(1) })).optional(),
    involved_companies: z.array(z.object({
      developer: z.boolean().optional(),
      publisher: z.boolean().optional(),
      company: z.object({ name: z.string().min(1) })
    })).optional(),
    external_games: z.array(z.object({
      category: z.number().int().nonnegative().optional(),
      uid: z.string().optional(),
      url: z.string().optional()
    })).optional()
  }).optional()
}));

type Fetcher = typeof fetch;
let cachedToken: { value: string; expiresAt: number } | undefined;

export class IgdbConnectorError extends Error {
  constructor(public readonly code: "NOT_CONFIGURED" | "UPSTREAM_FAILED") {
    super(code);
  }
}

export function normalizedGameTitle(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s:：·・'’"“”™®©\-—_.,，。!！?？()[\]{}]/g, "");
}

export function metadataSearchVariants(names: Array<string | null | undefined>) {
  const variants = names.flatMap((value) => {
    if (!value) return [];
    const cleaned = value.replace(/[™®©]/g, " ").replace(/\s+/g, " ").trim();
    return [cleaned, value.trim()];
  }).filter(Boolean);
  return [...new Set(variants)];
}

export function igdbSecondsToMinutes(seconds: number | undefined) {
  return seconds === undefined ? null : Math.round(seconds / 60);
}

export function uniqueExactIgdbCandidate<T extends { name: string; alternative_names?: { name: string }[] }>(name: string, candidates: T[]) {
  const normalized = normalizedGameTitle(name);
  const exact = candidates.filter((candidate) => [candidate.name, ...(candidate.alternative_names ?? []).map((item) => item.name)]
    .some((title) => normalizedGameTitle(title) === normalized));
  return exact.length === 1 ? exact[0] : null;
}

export function uniqueExactIgdbCandidateForNames<T extends { name: string; alternative_names?: { name: string }[] }>(names: string[], candidates: T[]) {
  const normalized = new Set(names.map(normalizedGameTitle).filter(Boolean));
  const exact = candidates.filter((candidate) => [candidate.name, ...(candidate.alternative_names ?? []).map((item) => item.name)]
    .some((title) => normalized.has(normalizedGameTitle(title))));
  const unique = [...new Map(exact.map((candidate) => [String((candidate as { id?: unknown }).id ?? candidate.name), candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function canonicalEnglishName(candidateName: string) {
  return /[A-Za-z]/.test(candidateName) ? candidateName : null;
}

async function igdbToken(fetcher: Fetcher) {
  const config = env();
  if (!config.IGDB_CLIENT_ID || !config.IGDB_CLIENT_SECRET) throw new IgdbConnectorError("NOT_CONFIGURED");
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", config.IGDB_CLIENT_ID);
  url.searchParams.set("client_secret", config.IGDB_CLIENT_SECRET);
  url.searchParams.set("grant_type", "client_credentials");
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", signal: AbortSignal.timeout(config.EXTERNAL_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new IgdbConnectorError("UPSTREAM_FAILED");
  }
  if (!response.ok) throw new IgdbConnectorError("UPSTREAM_FAILED");
  const parsed = tokenResponse.safeParse(await response.json());
  if (!parsed.success) throw new IgdbConnectorError("UPSTREAM_FAILED");
  cachedToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
  return cachedToken.value;
}

async function igdbRequest<T>(path: string, body: string, schema: z.ZodType<T>, fetcher: Fetcher) {
  const config = env();
  if (!config.IGDB_CLIENT_ID) throw new IgdbConnectorError("NOT_CONFIGURED");
  const token = await igdbToken(fetcher);
  let response: Response;
  try {
    response = await fetcher(`https://api.igdb.com/v4/${path}`, {
      method: "POST",
      headers: { "Client-ID": config.IGDB_CLIENT_ID, Authorization: `Bearer ${token}`, Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(config.EXTERNAL_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new IgdbConnectorError("UPSTREAM_FAILED");
  }
  if (!response.ok) {
    console.error(JSON.stringify({ connector: "IGDB", path, status: response.status, reason: "HTTP_STATUS" }));
    throw new IgdbConnectorError("UPSTREAM_FAILED");
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    console.error(JSON.stringify({ connector: "IGDB", path, reason: "SCHEMA_MISMATCH", issues: parsed.error.issues.slice(0, 8) }));
    throw new IgdbConnectorError("UPSTREAM_FAILED");
  }
  return parsed.data;
}

const catalogPlatformIds = [6, 48, 167, 130, 508] as const;

export function igdbDatePrecision(dateFormat: number | undefined) {
  if (dateFormat === 1) return "MONTH" as const;
  if (dateFormat === 2) return "YEAR" as const;
  if (dateFormat === 3 || dateFormat === 4 || dateFormat === 5 || dateFormat === 6) return "QUARTER" as const;
  if (dateFormat === 7) return "YEAR" as const;
  return "DAY" as const;
}

export function igdbCalendarPlatform(platformId: number, externalGames: Array<{ url?: string }> = []) {
  if (platformId === 48 || platformId === 167) return "PLAYSTATION";
  if (platformId === 130) return "NINTENDO_SWITCH";
  if (platformId === 508) return "NINTENDO_SWITCH_2";
  return externalGames.some((external) => officialStoreUrl(external.url, "STEAM")) ? "STEAM" : "PC_OTHER";
}

export function igdbCatalogEligible(game: { hypes?: number; total_rating_count?: number }, tracked = false) {
  return tracked || (game.hypes ?? 0) > 0 || (game.total_rating_count ?? 0) > 0;
}

type CatalogExternalGame = { uid?: string; url?: string };
type CatalogStoreProvider = "STEAM" | "PLAYSTATION" | "NINTENDO";

function parsedHttpsUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.endsWith(".")) return null;
    return url;
  } catch {
    return null;
  }
}

function officialStoreUrl(value: string | undefined, provider: CatalogStoreProvider) {
  const url = parsedHttpsUrl(value);
  if (!url) return null;
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (provider === "STEAM") return hostname === "store.steampowered.com" ? url : null;
  const registrableDomain = provider === "PLAYSTATION" ? "playstation.com" : "nintendo.com";
  return hostname === registrableDomain || hostname.endsWith(`.${registrableDomain}`) ? url : null;
}

function containsCjk(value: string | null | undefined) {
  return Boolean(value && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value));
}

export function igdbCatalogSteamAppId(externalGames: CatalogExternalGame[] = []) {
  for (const external of externalGames) {
    const url = officialStoreUrl(external.url, "STEAM");
    const fromUrl = url?.pathname.match(/^\/app\/(\d+)(?:\/|$)/i)?.[1];
    if (fromUrl) return Number(fromUrl);
  }
  return null;
}

export function igdbCatalogChineseName(names: Array<{ name: string }> = []) {
  return names.map((item) => item.name.trim()).find(containsCjk) ?? null;
}

export function igdbCatalogMetadataPriority(releaseDateSeconds: number, visibleFromSeconds: number) {
  return releaseDateSeconds >= visibleFromSeconds ? 0 : 1;
}

function catalogStoreProvider(platform: string) {
  if (platform === "STEAM") return "STEAM" as const;
  if (platform === "PLAYSTATION") return "PLAYSTATION" as const;
  if (platform.startsWith("NINTENDO")) return "NINTENDO" as const;
  return null;
}

function matchingStoreExternal(externalGames: CatalogExternalGame[], provider: CatalogStoreProvider) {
  const match = externalGames.map((external) => ({ external, url: officialStoreUrl(external.url, provider) }))
    .find((candidate) => candidate.url);
  if (!match) return null;
  if (provider === "STEAM") return match.url?.pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1] ?? match.external.uid ?? null;
  if (provider === "PLAYSTATION") return match.external.uid ?? match.url?.pathname.match(/\/(?:concept|product)\/([^/]+)/)?.[1] ?? null;
  return match.external.uid ?? match.url?.pathname.match(/\/store\/products\/([^/]+)/)?.[1] ?? null;
}

export function igdbCatalogStoreUrl(externalGames: Array<{ url?: string }> = [], platform: string) {
  const provider = catalogStoreProvider(platform);
  if (provider) {
    return externalGames.map((external) => officialStoreUrl(external.url, provider)?.toString())
      .find((url): url is string => Boolean(url)) ?? null;
  }
  return externalGames.map((external) => parsedHttpsUrl(external.url)?.toString())
    .find((url): url is string => Boolean(url)) ?? null;
}

export async function syncIgdbReleaseCatalog(
  ownerUserId: string,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
  options: { from?: Date; to?: Date; metadataBatchLimit?: number } = {}
) {
  const config = env();
  if (!config.IGDB_CLIENT_ID || !config.IGDB_CLIENT_SECRET) throw new IgdbConnectorError("NOT_CONFIGURED");
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "IGDB",
    idempotencyKey,
    status: "RUNNING",
    startedAt: new Date()
  }).onConflictDoNothing().returning();
  const job = createdJob ?? (await db.select().from(syncJobs).where(and(
    eq(syncJobs.ownerUserId, ownerUserId),
    eq(syncJobs.idempotencyKey, idempotencyKey)
  )).limit(1))[0];
  if (!createdJob) return { reused: true, job };
  const from = options.from ?? new Date(Date.now() - 62 * 24 * 60 * 60 * 1000);
  const to = options.to ?? new Date(Date.now() + 730 * 24 * 60 * 60 * 1000);
  try {
    const all = [] as z.infer<typeof releaseCatalogResponse>;
    for (let offset = 0; ; offset += 500) {
      const page = await igdbRequest(
        "release_dates",
        `fields id,date,date_format,human,region,platform.id,platform.name,game.id,game.name,game.hypes,game.total_rating_count,game.summary,game.alternative_names.name,game.cover.url,game.genres.name,game.involved_companies.developer,game.involved_companies.publisher,game.involved_companies.company.name,game.external_games.category,game.external_games.uid,game.external_games.url; where date >= ${Math.floor(from.getTime() / 1000)} & date <= ${Math.floor(to.getTime() / 1000)} & platform = (${catalogPlatformIds.join(",")}); sort date asc; limit 500; offset ${offset};`,
        releaseCatalogResponse,
        fetcher
      );
      all.push(...page);
      if (page.length < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const localGames = await db.select({ id: games.id, nameZh: games.nameZh, nameEn: games.nameEn, igdbGameId: games.igdbGameId })
      .from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)));
    const localByIgdb = new Map(localGames.filter((game) => game.igdbGameId !== null).map((game) => [game.igdbGameId!, game]));
    const selected = all.filter((release) => release.game && igdbCatalogEligible(release.game, localByIgdb.has(release.game.id)));
    const currentCatalog = await db.select().from(gameReleaseEvents).where(and(
      eq(gameReleaseEvents.ownerUserId, ownerUserId),
      eq(gameReleaseEvents.source, "IGDB"),
      like(gameReleaseEvents.dedupeKey, "catalog:igdb:release:%")
    ));
    const currentByIgdb = new Map<string, typeof currentCatalog>();
    for (const event of currentCatalog) {
      if (!event.externalGameId) continue;
      currentByIgdb.set(event.externalGameId, [...(currentByIgdb.get(event.externalGameId) ?? []), event]);
    }
    const visibleFromSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const gamesByRelease = [...new Map(selected.filter((release) => release.game).map((release) => [release.game!.id, release]))
      .values()].sort((left, right) => igdbCatalogMetadataPriority(left.date, visibleFromSeconds)
        - igdbCatalogMetadataPriority(right.date, visibleFromSeconds) || left.date - right.date);
    const metadataBatchLimit = Math.max(0, Math.min(options.metadataBatchLimit ?? 12, 50));
    const staleMetadataBefore = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const metadataCandidates = gamesByRelease.filter((release) => {
      if (!release.game || !igdbCatalogSteamAppId(release.game.external_games)) return false;
      const existing = currentByIgdb.get(String(release.game.id)) ?? [];
      return !existing.some((event) => event.metadataFetchedAt && event.metadataFetchedAt.getTime() >= staleMetadataBefore
        && event.summaryZh && event.summaryEn && event.coverUrl && event.genresZh.length && event.genresEn.length);
    }).slice(0, metadataBatchLimit);
    const localizedByIgdb = new Map<number, Awaited<ReturnType<typeof fetchSteamStoreMetadata>>>();
    let localizedFailed = 0;
    for (const candidate of metadataCandidates) {
      if (!candidate.game) continue;
      const appId = igdbCatalogSteamAppId(candidate.game.external_games);
      if (!appId) continue;
      try {
        localizedByIgdb.set(candidate.game.id, await fetchSteamStoreMetadata(appId, fetcher, { includeReviews: false }));
      } catch {
        localizedFailed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const now = new Date();
    let created = 0;
    let updated = 0;
    let pruned = 0;
    await db.transaction(async (transaction) => {
      for (const release of selected) {
        if (!release.game) continue;
        const local = localByIgdb.get(release.game.id);
        const platform = igdbCalendarPlatform(release.platform.id, release.game.external_games);
        const externalGames = release.game.external_games ?? [];
        const provider = catalogStoreProvider(platform);
        const localized = localizedByIgdb.get(release.game.id);
        const nameZh = localized?.nameZh ?? local?.nameZh ?? igdbCatalogChineseName(release.game.alternative_names) ?? release.game.name;
        const nameEn = localized?.nameEn ?? local?.nameEn ?? release.game.name;
        const developers = localized?.developers.length
          ? localized.developers
          : [...new Set((release.game.involved_companies ?? []).filter((company) => company.developer).map((company) => company.company.name))];
        const publishers = localized?.publishers.length
          ? localized.publishers
          : [...new Set((release.game.involved_companies ?? []).filter((company) => company.publisher).map((company) => company.company.name))];
        const storeUrl = igdbCatalogStoreUrl(externalGames, platform);
        const providerExternalId = provider ? matchingStoreExternal(externalGames, provider) : null;
        const values = {
          ownerUserId,
          gameId: local?.id ?? null,
          source: "IGDB" as const,
          dedupeKey: `catalog:igdb:release:${release.id}`,
          externalGameId: String(release.game.id),
          nameZh,
          nameEn,
          platform,
          releaseDate: new Date(release.date * 1000).toISOString().slice(0, 10),
          datePrecision: igdbDatePrecision(release.date_format),
          region: release.region === 1 ? "EUROPE" : release.region === 2 ? "NORTH_AMERICA" : release.region === 3 ? "AUSTRALIA" : release.region === 4 ? "NEW_ZEALAND" : release.region === 5 ? "JAPAN" : release.region === 6 ? "CHINA" : release.region === 7 ? "ASIA" : "GLOBAL",
          isAnnounced: true,
          storeUrl,
          coverUrl: localized?.coverUrl ?? (release.game.cover?.url ? `https:${release.game.cover.url}`.replace("t_thumb", "t_cover_big") : null),
          storeProvider: provider,
          storeExternalGameId: providerExternalId,
          summaryZh: localized?.summaryZh ?? null,
          summaryEn: localized?.summaryEn ?? (release.game.summary?.trim() || null),
          developers,
          publishers,
          genresZh: localized?.genresZh ?? [],
          genresEn: localized?.genresEn.length ? localized.genresEn : (release.game.genres ?? []).map((genre) => genre.name),
          metadataFetchedAt: localized ? now : null,
          fetchedAt: now,
          updatedAt: now
        };
        const inserted = await transaction.insert(gameReleaseEvents).values(values).onConflictDoNothing().returning({ id: gameReleaseEvents.id });
        if (inserted.length) created += 1;
        else {
          const updateValues = localized ? values : {
            ...values,
            nameZh: containsCjk(values.nameZh) ? values.nameZh : undefined,
            summaryZh: undefined,
            genresZh: undefined,
            metadataFetchedAt: undefined
          };
          await transaction.update(gameReleaseEvents).set(updateValues).where(and(
            eq(gameReleaseEvents.ownerUserId, ownerUserId),
            eq(gameReleaseEvents.dedupeKey, values.dedupeKey)
          ));
          updated += 1;
        }
      }
      const catalogWindow = and(
        eq(gameReleaseEvents.ownerUserId, ownerUserId),
        eq(gameReleaseEvents.source, "IGDB"),
        like(gameReleaseEvents.dedupeKey, "catalog:igdb:release:%"),
        gte(gameReleaseEvents.releaseDate, from.toISOString().slice(0, 10)),
        lte(gameReleaseEvents.releaseDate, to.toISOString().slice(0, 10))
      );
      const keepKeys = selected.filter((release) => release.game).map((release) => `catalog:igdb:release:${release.id}`);
      const removed = await transaction.delete(gameReleaseEvents).where(keepKeys.length
        ? and(catalogWindow, notInArray(gameReleaseEvents.dedupeKey, keepKeys))
        : catalogWindow).returning({ id: gameReleaseEvents.id });
      pruned = removed.length;
    });
    await db.update(syncJobs).set({
      status: localizedFailed ? "PARTIAL" : "SUCCEEDED",
      processedCount: all.length,
      createdCount: created,
      updatedCount: updated,
      skippedCount: localizedFailed,
      summary: {
        from: from.toISOString(),
        to: to.toISOString(),
        platformIds: catalogPlatformIds,
        eligibleCount: selected.length,
        pruned,
        metadataBatchLimit,
        localizedProcessed: localizedByIgdb.size,
        localizedFailed
      },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return {
      reused: false,
      jobId: job.id,
      processed: all.length,
      selected: selected.length,
      created,
      updated,
      pruned,
      localizedProcessed: localizedByIgdb.size,
      localizedFailed
    };
  } catch (error) {
    await db.update(syncJobs).set({ status: "FAILED", errorCode: error instanceof IgdbConnectorError ? error.code : "UPSTREAM_FAILED", errorMessage: "IGDB 发售目录同步失败", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }
}

const genreListResponse = z.array(z.object({
  id: z.number().int().positive(),
  genres: z.array(z.object({ name: z.string().min(1) })).optional()
}));

/**
 * 把 IGDB genre 名称按受控词表映射后回填到 games.primaryGenre / games.subGenres。
 * 尊重 gameFieldLocks（PRIMARY_GENRE / SUB_GENRES）：人工锁定字段不覆盖；无法映射的留空待人工。
 */
export async function applyIgdbGenreMapping(
  ownerUserId: string,
  entries: Array<{ gameId: string; genreNames: string[] }>,
  now = new Date()
) {
  let updated = 0;
  let lockedSkipped = 0;
  let unmapped = 0;
  for (const entry of entries) {
    const mapped = mapExternalGenres(entry.genreNames);
    if (!mapped.primaryGenre && !mapped.subGenres.length) {
      unmapped += 1;
      continue;
    }
    await db.transaction(async (transaction) => {
      const locks = new Set((await transaction.select({ field: gameFieldLocks.field })
        .from(gameFieldLocks).where(eq(gameFieldLocks.gameId, entry.gameId))).map((lock) => lock.field));
      const patch: Record<string, unknown> = {};
      if (!locks.has("PRIMARY_GENRE") && mapped.primaryGenre) patch.primaryGenre = mapped.primaryGenre;
      if (!locks.has("SUB_GENRES") && mapped.subGenres.length) patch.subGenres = mapped.subGenres;
      if (!Object.keys(patch).length) {
        lockedSkipped += 1;
        return;
      }
      patch.genreSource = "IGDB";
      patch.updatedAt = now;
      patch.version = sql`${games.version} + 1`;
      const result = await transaction.update(games).set(patch).where(and(
        eq(games.id, entry.gameId),
        eq(games.ownerUserId, ownerUserId),
        isNull(games.deletedAt)
      )).returning({ id: games.id });
      if (result.length) updated += 1;
    });
  }
  return { updated, lockedSkipped, unmapped };
}

export async function syncIgdbGenres(
  ownerUserId: string,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
  options: { missingOnly?: boolean; afterId?: string; batchLimit?: number } = {}
) {
  const config = env();
  if (!config.IGDB_CLIENT_ID || !config.IGDB_CLIENT_SECRET) throw new IgdbConnectorError("NOT_CONFIGURED");
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "IGDB",
    idempotencyKey,
    status: "RUNNING",
    startedAt: new Date()
  }).onConflictDoNothing().returning();
  const job = createdJob ?? (await db.select().from(syncJobs).where(and(
    eq(syncJobs.ownerUserId, ownerUserId),
    eq(syncJobs.idempotencyKey, idempotencyKey)
  )).limit(1))[0];
  if (!createdJob) return { reused: true as const, job };
  try {
    const missingOnly = options.missingOnly ?? true;
    const batchLimit = Math.max(1, Math.min(options.batchLimit ?? 100, 200));
    const pending = await db.select({ id: games.id, igdbGameId: games.igdbGameId }).from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt),
      isNotNull(games.igdbGameId),
      ...(missingOnly ? [isNull(games.primaryGenre), sql`coalesce(array_length(${games.subGenres}, 1), 0) = 0`] : []),
      ...(options.afterId ? [gt(games.id, options.afterId)] : [])
    )).orderBy(asc(games.id)).limit(batchLimit);
    let entries: Array<{ gameId: string; genreNames: string[] }> = [];
    if (pending.length) {
      const ids = [...new Set(pending.map((game) => game.igdbGameId!))];
      const rows = await igdbRequest(
        "games",
        `fields id,genres.name; where id = (${ids.join(",")}); limit ${ids.length};`,
        genreListResponse,
        fetcher
      );
      const genresById = new Map(rows.map((row) => [row.id, (row.genres ?? []).map((genre) => genre.name)]));
      entries = pending.map((game) => ({ gameId: game.id, genreNames: genresById.get(game.igdbGameId!) ?? [] }));
    }
    const result = await applyIgdbGenreMapping(ownerUserId, entries);
    const lastCursor = pending.length ? pending[pending.length - 1].id : null;
    await db.update(syncJobs).set({
      status: "SUCCEEDED",
      cursor: lastCursor,
      processedCount: pending.length,
      updatedCount: result.updated,
      skippedCount: result.lockedSkipped + result.unmapped,
      summary: { batchLimit, missingOnly, ...result, hasMore: pending.length === batchLimit },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return {
      reused: false as const,
      jobId: job.id,
      processed: pending.length,
      updated: result.updated,
      lockedSkipped: result.lockedSkipped,
      unmapped: result.unmapped,
      lastCursor,
      hasMore: pending.length === batchLimit
    };
  } catch (error) {
    const code = error instanceof IgdbConnectorError ? error.code : "UPSTREAM_FAILED";
    await db.update(syncJobs).set({ status: "FAILED", errorCode: code, errorMessage: "IGDB 类型同步失败", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }
}

async function metadataForGame(game: typeof games.$inferSelect, fetcher: Fetcher) {
  const names = metadataSearchVariants([game.nameEn, game.nameZh]);
  let candidate: z.infer<typeof searchResponse>[number] | null = null;
  if (game.igdbGameId) {
    const candidates = await igdbRequest(
      "games",
      `fields id,name,first_release_date,rating,rating_count,aggregated_rating,aggregated_rating_count,alternative_names.name,cover.url,release_dates.date; where id = ${game.igdbGameId}; limit 1;`,
      searchResponse,
      fetcher
    );
    candidate = candidates[0] ?? null;
  } else {
    for (const query of names) {
      const escaped = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const candidates = await igdbRequest(
        "games",
        `search "${escaped}"; fields id,name,first_release_date,rating,rating_count,aggregated_rating,aggregated_rating_count,alternative_names.name,cover.url,release_dates.date; limit 10;`,
        searchResponse,
        fetcher
      );
      candidate = uniqueExactIgdbCandidateForNames(names, candidates);
      if (candidate) break;
    }
  }
  if (!candidate) return null;
  const times = await igdbRequest(
    "game_time_to_beats",
    `fields game_id,hastily,normally,completely,count; where game_id = ${candidate.id}; limit 1;`,
    timeResponse,
    fetcher
  );
  const releaseSeconds = candidate.release_dates?.map((item) => item.date).filter((value): value is number => Boolean(value)).sort((a, b) => a - b)[0]
    ?? candidate.first_release_date;
  return {
    candidate,
    releaseDate: releaseSeconds ? new Date(releaseSeconds * 1000).toISOString().slice(0, 10) : null,
    coverUrl: candidate.cover?.url ? `https:${candidate.cover.url}`.replace("t_thumb", "t_cover_big") : null,
    hastilyMinutes: igdbSecondsToMinutes(times[0]?.hastily),
    normallyMinutes: igdbSecondsToMinutes(times[0]?.normally),
    completelyMinutes: igdbSecondsToMinutes(times[0]?.completely),
    submissionCount: times[0]?.count ?? 0
  };
}

export async function syncIgdbMetadata(
  ownerUserId: string,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
  options: { retryBefore?: Date; missingOnly?: boolean } = {}
) {
  const config = env();
  if (!config.IGDB_CLIENT_ID || !config.IGDB_CLIENT_SECRET) throw new IgdbConnectorError("NOT_CONFIGURED");
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "IGDB",
    idempotencyKey,
    status: "RUNNING",
    startedAt: new Date()
  }).onConflictDoNothing().returning();
  const job = createdJob ?? (await db.select().from(syncJobs).where(and(
    eq(syncJobs.ownerUserId, ownerUserId),
    eq(syncJobs.idempotencyKey, idempotencyKey)
  )).limit(1))[0];
  if (!createdJob) return { reused: true, job };
  try {
    const retryBefore = options.retryBefore ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pending = await db.select().from(games).where(and(
      eq(games.ownerUserId, ownerUserId),
      isNull(games.deletedAt),
      or(
        isNull(games.igdbGameId),
        isNull(games.estimatedNormallyMinutes),
        isNull(games.nameEn),
        isNull(games.releaseDate),
        isNull(games.communityRating),
        isNull(games.criticRating)
      ),
      or(isNull(games.igdbLastAttemptAt), lt(games.igdbLastAttemptAt, retryBefore))
    )).orderBy(asc(games.id)).limit(20);
    let updated = 0;
    let skipped = 0;
    let lastCursor: string | null = null;
    for (const game of pending) {
      lastCursor = game.id;
      try {
        const metadata = await metadataForGame(game, fetcher);
        if (!metadata) {
          skipped += 1;
          await db.update(games).set({ igdbLastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(games.id, game.id));
          continue;
        }
        await db.transaction(async (transaction) => {
          const locks = new Set((await transaction.select({ field: gameFieldLocks.field })
            .from(gameFieldLocks).where(eq(gameFieldLocks.gameId, game.id))).map((lock) => lock.field));
          const patch: Record<string, unknown> = {
            igdbGameId: game.igdbGameId ?? metadata.candidate.id,
            igdbLastAttemptAt: new Date(),
            updatedAt: new Date(),
            version: sql`${games.version} + 1`
          };
          if (!locks.has("COVER_URL") && metadata.coverUrl && (!options.missingOnly || !game.coverUrl)) {
            patch.coverUrl = metadata.coverUrl;
            patch.coverUrlSource = "IGDB";
          }
          if (game.estimateSource !== "HLTB") {
            if (!locks.has("MAIN_STORY_MINUTES") && metadata.hastilyMinutes !== null
              && (!options.missingOnly || game.estimatedHastilyMinutes === null)) patch.estimatedHastilyMinutes = metadata.hastilyMinutes;
            if (!locks.has("EXTRA_STORY_MINUTES") && metadata.normallyMinutes !== null
              && (!options.missingOnly || game.estimatedNormallyMinutes === null)) patch.estimatedNormallyMinutes = metadata.normallyMinutes;
            if (!locks.has("COMPLETIONIST_MINUTES") && metadata.completelyMinutes !== null
              && (!options.missingOnly || game.estimatedCompletelyMinutes === null)) patch.estimatedCompletelyMinutes = metadata.completelyMinutes;
            if (patch.estimatedHastilyMinutes !== undefined || patch.estimatedNormallyMinutes !== undefined
              || patch.estimatedCompletelyMinutes !== undefined) patch.estimateSource = "IGDB";
          }
          const englishName = canonicalEnglishName(metadata.candidate.name);
          if (!locks.has("NAME_EN") && !game.nameEn && englishName) {
            patch.nameEn = englishName;
            patch.nameEnSource = "IGDB";
          }
          if (!locks.has("RELEASE_DATE") && metadata.releaseDate && game.releaseDateSource !== "MANUAL"
            && (!options.missingOnly || !game.releaseDate)) {
            patch.releaseDate = metadata.releaseDate;
            patch.releaseDateSource = "IGDB";
          }
          if (game.ratingSource === null || game.ratingSource === "IGDB") {
            let ratingChanged = false;
            if (!locks.has("COMMUNITY_RATING") && metadata.candidate.rating !== undefined
              && (!options.missingOnly || game.communityRating === null)) {
              patch.communityRating = metadata.candidate.rating;
              patch.communityRatingCount = metadata.candidate.rating_count ?? null;
              ratingChanged = true;
            }
            if (!locks.has("CRITIC_RATING") && metadata.candidate.aggregated_rating !== undefined
              && (!options.missingOnly || game.criticRating === null)) {
              patch.criticRating = metadata.candidate.aggregated_rating;
              patch.criticRatingCount = metadata.candidate.aggregated_rating_count ?? null;
              ratingChanged = true;
            }
            if (ratingChanged) {
              patch.ratingSource = "IGDB";
              patch.ratingUpdatedAt = new Date();
            }
          }
          await transaction.update(games).set(patch).where(eq(games.id, game.id));
          await transaction.insert(externalGameMappings).values({
            gameId: game.id,
            provider: "IGDB",
            externalGameId: String(metadata.candidate.id),
            matchConfidence: 100,
            manuallyConfirmed: false
          }).onConflictDoUpdate({
            target: [externalGameMappings.provider, externalGameMappings.externalGameId],
            set: { gameId: game.id, updatedAt: new Date() }
          });
        });
        updated += 1;
      } catch (error) {
        if (error instanceof IgdbConnectorError && error.code === "NOT_CONFIGURED") throw error;
        skipped += 1;
        await db.update(games).set({ igdbLastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(games.id, game.id));
      }
    }
    const status = skipped > 0 ? "PARTIAL" : "SUCCEEDED";
    await db.update(syncJobs).set({
      status,
      cursor: lastCursor,
      processedCount: pending.length,
      updatedCount: updated,
      skippedCount: skipped,
      summary: { batchLimit: 20, remainingRequiresAnotherRun: pending.length === 20 },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return { reused: false, jobId: job.id, processed: pending.length, updated, skipped, hasMore: pending.length === 20 };
  } catch (error) {
    const code = error instanceof IgdbConnectorError ? error.code : "UPSTREAM_FAILED";
    await db.update(syncJobs).set({ status: "FAILED", errorCode: code, errorMessage: "IGDB 同步失败", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    throw error;
  }
}
