import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import { externalAccounts, gameReleaseEvents, games, platformWishlistItems, syncJobs } from "@/server/db/schema";
import { normalizeSteamTitle, SteamConnectorError } from "./steam";

const wishlistResponse = z.object({
  response: z.object({
    items: z.array(z.object({
      appid: z.number().int().positive(),
      priority: z.number().int().nonnegative().optional(),
      date_added: z.number().int().nonnegative().optional()
    })).default([])
  })
});

const storeDetailsResponse = z.record(z.string(), z.object({
  success: z.boolean(),
  data: z.object({
    name: z.string().min(1),
    header_image: z.string().url().optional(),
    release_date: z.object({ coming_soon: z.boolean().optional(), date: z.string().optional() }).optional()
  }).optional()
}));

type Fetcher = typeof fetch;

function parseSteamReleaseDate(value: string | undefined) {
  if (!value) return null;
  const year = value.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  if (/^\s*20\d{2}\s*$/.test(value)) return { date: `${year}-12-31`, precision: "YEAR" as const };
  const quarter = value.match(/\bQ([1-4])\b/i)?.[1];
  if (quarter) return { date: `${year}-${String(Number(quarter) * 3).padStart(2, "0")}-${Number(quarter) === 1 || Number(quarter) === 4 ? "31" : "30"}`, precision: "QUARTER" as const };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { date: new Date(parsed).toISOString().slice(0, 10), precision: "DAY" as const } : null;
}

export async function fetchSteamWishlist(steamId: string, apiKey: string, fetcher: Fetcher = fetch) {
  const url = new URL("https://api.steampowered.com/IWishlistService/GetWishlist/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new SteamConnectorError("UPSTREAM_FAILED");
  }
  if (!response.ok) throw new SteamConnectorError("UPSTREAM_FAILED");
  const parsed = wishlistResponse.safeParse(await response.json());
  if (!parsed.success) throw new SteamConnectorError("UPSTREAM_FAILED");
  return parsed.data.response.items;
}

async function fetchSteamWishlistDetails(appId: number, fetcher: Fetcher) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appId));
  url.searchParams.set("l", "english");
  url.searchParams.set("cc", "us");
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const parsed = storeDetailsResponse.safeParse(await response.json());
  if (!parsed.success) return null;
  const item = parsed.data[String(appId)];
  if (!item?.success || !item.data) return null;
  return {
    name: item.data.name,
    coverUrl: item.data.header_image ?? null,
    release: parseSteamReleaseDate(item.data.release_date?.date),
    comingSoon: Boolean(item.data.release_date?.coming_soon),
    storeUrl: `https://store.steampowered.com/app/${appId}/`
  };
}

export async function syncSteamWishlist(
  ownerUserId: string,
  idempotencyKey: string,
  options: { apiKey?: string; fetcher?: Fetcher } = {}
) {
  const apiKey = options.apiKey ?? env().STEAM_WEB_API_KEY;
  if (!apiKey) throw new SteamConnectorError("NOT_CONFIGURED");
  const account = (await db.select().from(externalAccounts).where(and(
    eq(externalAccounts.ownerUserId, ownerUserId),
    eq(externalAccounts.provider, "STEAM")
  )).limit(1))[0];
  if (!account || account.status === "DISABLED") throw new SteamConnectorError("ACCOUNT_MISSING");
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
  const fetcher = options.fetcher ?? fetch;
  try {
    const items = await fetchSteamWishlist(account.externalUserId, apiKey, fetcher);
    const localGames = await db.select().from(games).where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)));
    const localByApp = new Map(localGames.filter((game) => game.steamAppId !== null).map((game) => [game.steamAppId!, game]));
    const localByTitle = new Map<string, typeof localGames>();
    for (const game of localGames) for (const title of [game.nameZh, game.nameEn]) {
      if (!title) continue;
      const key = normalizeSteamTitle(title);
      localByTitle.set(key, [...(localByTitle.get(key) ?? []), game]);
    }
    let updated = 0;
    let skipped = 0;
    const enriched: Array<{ item: typeof items[number]; details: NonNullable<Awaited<ReturnType<typeof fetchSteamWishlistDetails>>> }> = [];
    for (const item of items) {
      const details = await fetchSteamWishlistDetails(item.appid, fetcher);
      if (!details) skipped += 1;
      else enriched.push({ item, details });
    }
    const now = new Date();
    await db.transaction(async (transaction) => {
      await transaction.update(platformWishlistItems).set({ isActive: false, updatedAt: now })
        .where(and(eq(platformWishlistItems.ownerUserId, ownerUserId), eq(platformWishlistItems.provider, "STEAM")));
      for (const { item, details } of enriched) {
        const exactCandidates = localByTitle.get(normalizeSteamTitle(details.name)) ?? [];
        const matched = localByApp.get(item.appid) ?? (exactCandidates.length === 1 ? exactCandidates[0] : undefined);
        await transaction.insert(platformWishlistItems).values({
          ownerUserId,
          provider: "STEAM",
          externalGameId: String(item.appid),
          name: details.name,
          priority: item.priority ?? null,
          addedAt: item.date_added ? new Date(item.date_added * 1000) : null,
          platform: "STEAM",
          coverUrl: details.coverUrl,
          releaseDate: details.release?.date ?? null,
          releaseDatePrecision: details.release?.precision ?? "DAY",
          storeUrl: details.storeUrl,
          matchedGameId: matched?.id ?? null,
          isActive: true,
          rawMetadata: { comingSoon: details.comingSoon },
          lastSeenAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: [platformWishlistItems.ownerUserId, platformWishlistItems.provider, platformWishlistItems.externalGameId],
          set: {
            name: details.name,
            priority: item.priority ?? null,
            addedAt: item.date_added ? new Date(item.date_added * 1000) : null,
            coverUrl: details.coverUrl,
            releaseDate: details.release?.date ?? null,
            releaseDatePrecision: details.release?.precision ?? "DAY",
            storeUrl: details.storeUrl,
            matchedGameId: matched?.id ?? null,
            isActive: true,
            rawMetadata: { comingSoon: details.comingSoon },
            lastSeenAt: now,
            updatedAt: now
          }
        });
        if (details.release) await transaction.insert(gameReleaseEvents).values({
          ownerUserId,
          gameId: matched?.id ?? null,
          source: "STEAM",
          dedupeKey: `wishlist:steam:${item.appid}`,
          externalGameId: String(item.appid),
          nameZh: matched?.nameZh ?? details.name,
          nameEn: matched?.nameEn ?? details.name,
          platform: "STEAM",
          releaseDate: details.release.date,
          datePrecision: details.release.precision,
          storeUrl: details.storeUrl,
          coverUrl: details.coverUrl,
          fetchedAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: [gameReleaseEvents.ownerUserId, gameReleaseEvents.dedupeKey],
          set: { gameId: matched?.id ?? null, nameZh: matched?.nameZh ?? details.name, nameEn: matched?.nameEn ?? details.name, releaseDate: details.release.date, datePrecision: details.release.precision, storeUrl: details.storeUrl, coverUrl: details.coverUrl, fetchedAt: now, updatedAt: now }
        });
        updated += 1;
      }
    });
    await db.update(syncJobs).set({
      status: skipped ? "PARTIAL" : "SUCCEEDED",
      processedCount: items.length,
      updatedCount: updated,
      skippedCount: skipped,
      summary: { activeWishlistItems: updated },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return { reused: false, jobId: job.id, processed: items.length, updated, skipped };
  } catch (error) {
    await db.update(syncJobs).set({ status: "FAILED", errorCode: error instanceof SteamConnectorError ? error.code : "UPSTREAM_FAILED", errorMessage: "Steam 愿望单同步失败", completedAt: new Date(), updatedAt: new Date() }).where(eq(syncJobs.id, job.id));
    throw error;
  }
}
