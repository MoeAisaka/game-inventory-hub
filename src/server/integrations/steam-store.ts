import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import {
  gameFieldLocks,
  gameMetadataCandidates,
  gameRatings,
  gameReleaseEvents,
  games,
  steamLibraryItems,
  syncJobs
} from "@/server/db/schema";

const appDetailsData = z.object({
  name: z.string().min(1),
  header_image: z.string().url().optional(),
  release_date: z.object({ coming_soon: z.boolean().optional(), date: z.string().optional() }).optional(),
  metacritic: z.object({ score: z.number().min(0).max(100), url: z.string().url().optional() }).optional()
});

const appDetailsResponse = z.record(z.string(), z.object({
  success: z.boolean(),
  data: appDetailsData.optional()
}));

const reviewResponse = z.object({
  success: z.number().int(),
  query_summary: z.object({
    total_positive: z.number().int().nonnegative(),
    total_negative: z.number().int().nonnegative(),
    total_reviews: z.number().int().nonnegative(),
    review_score_desc: z.string().optional()
  })
});

type Fetcher = typeof fetch;

export class SteamStoreConnectorError extends Error {
  constructor(public readonly code: "UPSTREAM_FAILED") {
    super(code);
  }
}

async function jsonRequest(url: URL, fetcher: Fetcher) {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "user-agent": "GameInventoryHub/0.13.1" },
      signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new SteamStoreConnectorError("UPSTREAM_FAILED");
  }
  if (!response.ok) throw new SteamStoreConnectorError("UPSTREAM_FAILED");
  return response.json();
}

function releaseDate(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(`${value} UTC`);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const chinese = value.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!chinese) return null;
  const [, year, month, day] = chinese;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function containsCjk(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

export async function fetchSteamStoreMetadata(appId: number, fetcher: Fetcher = fetch) {
  const detailsUrl = (language: string) => {
    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", String(appId));
    url.searchParams.set("cc", "cn");
    url.searchParams.set("l", language);
    return url;
  };
  const reviewsUrl = new URL(`https://store.steampowered.com/appreviews/${appId}`);
  reviewsUrl.searchParams.set("json", "1");
  reviewsUrl.searchParams.set("language", "all");
  reviewsUrl.searchParams.set("purchase_type", "all");
  reviewsUrl.searchParams.set("num_per_page", "0");
  const [zhRaw, enRaw, reviewsRaw] = await Promise.all([
    jsonRequest(detailsUrl("schinese"), fetcher),
    jsonRequest(detailsUrl("english"), fetcher),
    jsonRequest(reviewsUrl, fetcher)
  ]);
  const zh = appDetailsResponse.safeParse(zhRaw);
  const en = appDetailsResponse.safeParse(enRaw);
  const reviews = reviewResponse.safeParse(reviewsRaw);
  if (!zh.success || !en.success || !reviews.success) throw new SteamStoreConnectorError("UPSTREAM_FAILED");
  const zhData = zh.data[String(appId)]?.success ? zh.data[String(appId)]?.data : undefined;
  const enData = en.data[String(appId)]?.success ? en.data[String(appId)]?.data : undefined;
  if (!zhData && !enData) throw new SteamStoreConnectorError("UPSTREAM_FAILED");
  const details = enData ?? zhData!;
  const totalReviews = reviews.data.query_summary.total_reviews;
  const positiveRate = totalReviews
    ? Math.round((reviews.data.query_summary.total_positive / totalReviews) * 10_000) / 100
    : null;
  return {
    appId,
    nameZh: zhData?.name ?? null,
    nameEn: enData?.name ?? details.name,
    coverUrl: details.header_image ?? zhData?.header_image ?? null,
    releaseDate: releaseDate(enData?.release_date?.date ?? zhData?.release_date?.date),
    comingSoon: Boolean(enData?.release_date?.coming_soon ?? zhData?.release_date?.coming_soon),
    communityRating: positiveRate,
    communityRatingCount: totalReviews,
    communityRatingLabel: reviews.data.query_summary.review_score_desc ?? null,
    criticRating: details.metacritic?.score ?? null,
    criticUrl: details.metacritic?.url ?? null,
    storeUrl: `https://store.steampowered.com/app/${appId}/`
  };
}

export async function syncSteamStoreMetadata(
  ownerUserId: string,
  idempotencyKey: string,
  fetcher: Fetcher = fetch
) {
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "STEAM",
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
    const [mappedRows, priorCandidates] = await Promise.all([
      db.select({ item: steamLibraryItems, game: games }).from(steamLibraryItems)
        .innerJoin(games, eq(games.id, steamLibraryItems.matchedGameId))
        .where(and(
          eq(steamLibraryItems.ownerUserId, ownerUserId),
          eq(steamLibraryItems.isOwned, true),
          eq(steamLibraryItems.matchStatus, "MATCHED"),
          isNull(games.deletedAt)
        )).orderBy(desc(steamLibraryItems.playtimeMinutes)),
      db.select({ gameId: gameMetadataCandidates.gameId, fetchedAt: gameMetadataCandidates.fetchedAt })
        .from(gameMetadataCandidates)
        .where(and(
          eq(gameMetadataCandidates.ownerUserId, ownerUserId),
          eq(gameMetadataCandidates.provider, "STEAM")
        ))
    ]);
    const latestFetched = new Map<string, number>();
    for (const candidate of priorCandidates) {
      latestFetched.set(candidate.gameId, Math.max(latestFetched.get(candidate.gameId) ?? 0, candidate.fetchedAt.getTime()));
    }
    const staleBefore = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const selected = [] as typeof mappedRows;
    const seenGames = new Set<string>();
    for (const row of mappedRows) {
      if (seenGames.has(row.game.id) || (latestFetched.get(row.game.id) ?? 0) >= staleBefore) continue;
      seenGames.add(row.game.id);
      selected.push(row);
      if (selected.length === 8) break;
    }

    let updated = 0;
    let skipped = 0;
    for (const row of selected) {
      try {
        const metadata = await fetchSteamStoreMetadata(row.item.steamAppId, fetcher);
        await db.transaction(async (transaction) => {
          const locks = new Set((await transaction.select({ field: gameFieldLocks.field })
            .from(gameFieldLocks).where(eq(gameFieldLocks.gameId, row.game.id))).map((lock) => lock.field));
          const patch: Record<string, unknown> = { updatedAt: new Date() };
          const applied = new Set<string>();
          if (!locks.has("NAME_ZH") && metadata.nameZh && containsCjk(metadata.nameZh)
            && (row.game.nameZh === row.item.name || row.game.nameZh === row.game.nameEn)) {
            patch.nameZh = metadata.nameZh;
            applied.add("NAME_ZH");
          }
          if (!locks.has("NAME_EN") && !row.game.nameEn && metadata.nameEn) {
            patch.nameEn = metadata.nameEn;
            patch.nameEnSource = "STEAM";
            applied.add("NAME_EN");
          }
          if (!locks.has("COVER_URL") && metadata.coverUrl
            && (!row.game.coverUrl || row.game.coverUrlSource === "STEAM")) {
            patch.coverUrl = metadata.coverUrl;
            patch.coverUrlSource = "STEAM";
            applied.add("COVER_URL");
          }
          if (!locks.has("RELEASE_DATE") && metadata.releaseDate && row.game.releaseDateSource !== "MANUAL") {
            patch.releaseDate = metadata.releaseDate;
            patch.releaseDateSource = "STEAM";
            applied.add("RELEASE_DATE");
          }
          if (!locks.has("COMMUNITY_RATING") && metadata.communityRating !== null
            && (row.game.ratingSource === null || row.game.ratingSource === "STEAM")) {
            patch.communityRating = metadata.communityRating;
            patch.communityRatingCount = metadata.communityRatingCount;
            patch.ratingSource = "STEAM";
            patch.ratingUpdatedAt = new Date();
            applied.add("COMMUNITY_RATING");
          }
          if (!locks.has("CRITIC_RATING") && metadata.criticRating !== null
            && (row.game.ratingSource === null || row.game.ratingSource === "STEAM" || row.game.ratingSource === "METACRITIC")) {
            patch.criticRating = metadata.criticRating;
            patch.ratingUpdatedAt = new Date();
            if (!metadata.communityRating) patch.ratingSource = "METACRITIC";
            applied.add("CRITIC_RATING");
          }
          const [updatedGame] = await transaction.update(games).set(patch).where(eq(games.id, row.game.id)).returning();
          const candidates = [
            ["NAME_ZH", metadata.nameZh, "Steam 简体中文商店名"],
            ["NAME_EN", metadata.nameEn, "Steam 英文商店名"],
            ["COVER_URL", metadata.coverUrl, "Steam 商店图"],
            ["RELEASE_DATE", metadata.releaseDate, "Steam 发售日期"],
            ["COMMUNITY_RATING", metadata.communityRating, metadata.communityRatingLabel ?? "Steam 好评率"],
            ["CRITIC_RATING", metadata.criticRating, "Metacritic"]
          ] as const;
          for (const [field, value, sourceLabel] of candidates) {
            await transaction.insert(gameMetadataCandidates).values({
              ownerUserId,
              gameId: row.game.id,
              provider: "STEAM",
              externalGameId: String(row.item.steamAppId),
              field,
              value: { value, sourceUrl: metadata.storeUrl, sourceLabel },
              confidence: value === null ? 0 : 100,
              status: applied.has(field) ? "APPLIED" : "PENDING",
              appliedAt: applied.has(field) ? new Date() : null,
              fetchedAt: new Date()
            }).onConflictDoUpdate({
              target: [gameMetadataCandidates.gameId, gameMetadataCandidates.provider, gameMetadataCandidates.externalGameId, gameMetadataCandidates.field],
              set: {
                value: { value, sourceUrl: metadata.storeUrl, sourceLabel },
                confidence: value === null ? 0 : 100,
                status: applied.has(field) ? "APPLIED" : "PENDING",
                appliedAt: applied.has(field) ? new Date() : null,
                fetchedAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
          if (metadata.communityRating !== null) {
            await transaction.insert(gameRatings).values({
              ownerUserId,
              gameId: row.game.id,
              source: "STEAM",
              kind: "COMMUNITY",
              score: metadata.communityRating,
              ratingCount: metadata.communityRatingCount,
              sourceUrl: metadata.storeUrl
            }).onConflictDoUpdate({
              target: [gameRatings.gameId, gameRatings.source, gameRatings.kind],
              set: { score: metadata.communityRating, ratingCount: metadata.communityRatingCount, sourceUrl: metadata.storeUrl, fetchedAt: new Date(), updatedAt: new Date() }
            });
          }
          if (metadata.criticRating !== null) {
            await transaction.insert(gameRatings).values({
              ownerUserId,
              gameId: row.game.id,
              source: "METACRITIC",
              kind: "CRITIC",
              score: metadata.criticRating,
              sourceUrl: metadata.criticUrl ?? metadata.storeUrl
            }).onConflictDoUpdate({
              target: [gameRatings.gameId, gameRatings.source, gameRatings.kind],
              set: { score: metadata.criticRating, sourceUrl: metadata.criticUrl ?? metadata.storeUrl, fetchedAt: new Date(), updatedAt: new Date() }
            });
          }
          if (updatedGame.releaseDate && updatedGame.platform) {
            const dedupeKey = `game:${updatedGame.id}:primary`;
            await transaction.insert(gameReleaseEvents).values({
              ownerUserId,
              gameId: updatedGame.id,
              source: updatedGame.releaseDateSource,
              dedupeKey,
              externalGameId: String(row.item.steamAppId),
              nameZh: updatedGame.nameZh,
              nameEn: updatedGame.nameEn,
              platform: updatedGame.platform,
              releaseDate: updatedGame.releaseDate,
              region: "GLOBAL",
              storeUrl: metadata.storeUrl,
              coverUrl: updatedGame.coverUrl
            }).onConflictDoUpdate({
              target: [gameReleaseEvents.ownerUserId, gameReleaseEvents.dedupeKey],
              set: {
                source: updatedGame.releaseDateSource,
                externalGameId: String(row.item.steamAppId),
                nameZh: updatedGame.nameZh,
                nameEn: updatedGame.nameEn,
                platform: updatedGame.platform,
                releaseDate: updatedGame.releaseDate,
                storeUrl: metadata.storeUrl,
                coverUrl: updatedGame.coverUrl,
                fetchedAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
        });
        updated += 1;
      } catch {
        skipped += 1;
      }
    }
    const hasMore = selected.length === 8;
    await db.update(syncJobs).set({
      status: skipped ? "PARTIAL" : "SUCCEEDED",
      processedCount: selected.length,
      updatedCount: updated,
      skippedCount: skipped,
      summary: { batchLimit: 8, hasMore, source: "STEAM_STORE" },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return { reused: false, jobId: job.id, processed: selected.length, updated, skipped, hasMore };
  } catch (error) {
    await db.update(syncJobs).set({
      status: "FAILED",
      errorCode: error instanceof SteamStoreConnectorError ? error.code : "UPSTREAM_FAILED",
      errorMessage: "Steam 商店元数据同步失败",
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    throw error;
  }
}
