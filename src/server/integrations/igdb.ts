import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import { externalGameMappings, games, syncJobs } from "@/server/db/schema";

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

export function igdbSecondsToMinutes(seconds: number | undefined) {
  return seconds === undefined ? null : Math.round(seconds / 60);
}

export function uniqueExactIgdbCandidate<T extends { name: string; alternative_names?: { name: string }[] }>(name: string, candidates: T[]) {
  const normalized = normalizedGameTitle(name);
  const exact = candidates.filter((candidate) => [candidate.name, ...(candidate.alternative_names ?? []).map((item) => item.name)]
    .some((title) => normalizedGameTitle(title) === normalized));
  return exact.length === 1 ? exact[0] : null;
}

function canonicalEnglishName(candidateName: string, localName: string) {
  return /[A-Za-z]/.test(candidateName) && normalizedGameTitle(candidateName) !== normalizedGameTitle(localName)
    ? candidateName
    : null;
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
  if (!response.ok) throw new IgdbConnectorError("UPSTREAM_FAILED");
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new IgdbConnectorError("UPSTREAM_FAILED");
  return parsed.data;
}

async function metadataForGame(name: string, fetcher: Fetcher) {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const candidates = await igdbRequest(
    "games",
    `search "${escaped}"; fields id,name,first_release_date,rating,rating_count,aggregated_rating,aggregated_rating_count,alternative_names.name,cover.url,release_dates.date; limit 10;`,
    searchResponse,
    fetcher
  );
  const candidate = uniqueExactIgdbCandidate(name, candidates);
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

export async function syncIgdbMetadata(ownerUserId: string, idempotencyKey: string, fetcher: Fetcher = fetch) {
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
    const retryBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
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
        const metadata = await metadataForGame(game.nameEn || game.nameZh, fetcher);
        if (!metadata) {
          skipped += 1;
          await db.update(games).set({ igdbLastAttemptAt: new Date(), updatedAt: new Date() }).where(eq(games.id, game.id));
          continue;
        }
        const patch: Record<string, unknown> = {
          igdbGameId: metadata.candidate.id,
          igdbLastAttemptAt: new Date(),
          estimatedHastilyMinutes: metadata.hastilyMinutes,
          estimatedNormallyMinutes: metadata.normallyMinutes,
          estimatedCompletelyMinutes: metadata.completelyMinutes,
          coverUrl: game.coverUrl ?? metadata.coverUrl,
          updatedAt: new Date(),
          version: sql`${games.version} + 1`
        };
        const englishName = canonicalEnglishName(metadata.candidate.name, game.nameZh);
        if (!game.nameEn && englishName) {
          patch.nameEn = englishName;
          patch.nameEnSource = "IGDB";
        }
        if (game.releaseDateSource !== "MANUAL" && metadata.releaseDate) {
          patch.releaseDate = metadata.releaseDate;
          patch.releaseDateSource = "IGDB";
        }
        if (game.ratingSource === null || game.ratingSource === "IGDB") {
          patch.communityRating = metadata.candidate.rating ?? null;
          patch.communityRatingCount = metadata.candidate.rating_count ?? null;
          patch.criticRating = metadata.candidate.aggregated_rating ?? null;
          patch.criticRatingCount = metadata.candidate.aggregated_rating_count ?? null;
          if (metadata.candidate.rating !== undefined || metadata.candidate.aggregated_rating !== undefined) {
            patch.ratingSource = "IGDB";
            patch.ratingUpdatedAt = new Date();
          }
        }
        await db.transaction(async (transaction) => {
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
