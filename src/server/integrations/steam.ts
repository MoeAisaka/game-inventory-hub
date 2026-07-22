import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/lib/env";
import { gameSearchVariants } from "@/lib/game-search";
import { db } from "@/server/db";
import {
  externalAccounts,
  externalGameMappings,
  gameAcquisitions,
  gameActivitySnapshots,
  games,
  steamLibraryItems,
  syncJobs
} from "@/server/db/schema";
import { getExternalAccount } from "./accounts";
import { recomputeSyncedGameActivity } from "@/server/services/game-activity";

const ownedGamesResponse = z.object({
  response: z.object({
    game_count: z.number().int().nonnegative().optional(),
    games: z.array(z.object({
      appid: z.number().int().positive(),
      name: z.string().min(1),
      playtime_forever: z.number().int().nonnegative().default(0),
      playtime_2weeks: z.number().int().nonnegative().optional(),
      img_icon_url: z.string().optional(),
      rtime_last_played: z.number().int().nonnegative().optional()
    })).default([])
  })
});

type SteamOwnedGame = z.infer<typeof ownedGamesResponse>["response"]["games"][number];

export class SteamConnectorError extends Error {
  constructor(public readonly code: "NOT_CONFIGURED" | "ACCOUNT_MISSING" | "PRIVATE_LIBRARY" | "UPSTREAM_FAILED") {
    super(code);
  }
}

export function uniqueSteamNameCandidate<T>(candidates: T[]) {
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function normalizeSteamTitle(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[™®©]/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function steamEnglishNameCandidate(externalName: string, localName: string) {
  return /[A-Za-z]/.test(externalName) && normalizeSteamTitle(externalName) !== normalizeSteamTitle(localName)
    ? externalName
    : null;
}

function steamIconUrl(game: SteamOwnedGame) {
  return game.img_icon_url
    ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
    : null;
}

function latestDate(current: Date | null, incoming: Date | null) {
  if (!current) return incoming;
  if (!incoming) return current;
  return current > incoming ? current : incoming;
}

export async function fetchSteamOwnedGames(
  steamId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch
) {
  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("format", "json");
  url.searchParams.set("include_appinfo", "true");
  url.searchParams.set("include_played_free_games", "true");
  url.searchParams.set("skip_unvetted_apps", "false");
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new SteamConnectorError("UPSTREAM_FAILED");
  }
  if (!response.ok) throw new SteamConnectorError("UPSTREAM_FAILED");
  const parsed = ownedGamesResponse.safeParse(await response.json());
  if (!parsed.success) throw new SteamConnectorError("UPSTREAM_FAILED");
  if (!parsed.data.response.game_count && !parsed.data.response.games.length) {
    throw new SteamConnectorError("PRIVATE_LIBRARY");
  }
  return parsed.data.response.games;
}

type SteamSyncOptions = {
  apiKey?: string;
  fetcher?: typeof fetch;
};

export async function syncSteamOwnedGames(
  ownerUserId: string,
  idempotencyKey: string,
  options: SteamSyncOptions = {}
) {
  const apiKey = options.apiKey ?? env().STEAM_WEB_API_KEY;
  if (!apiKey) throw new SteamConnectorError("NOT_CONFIGURED");
  const account = await getExternalAccount(ownerUserId, "STEAM");
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

  try {
    const owned = await fetchSteamOwnedGames(account.externalUserId, apiKey, options.fetcher ?? fetch);
    const counters = await db.transaction(async (transaction) => {
      const now = new Date();
      const [localGames, priorItems] = await Promise.all([
        transaction.select().from(games).where(and(
          eq(games.ownerUserId, ownerUserId),
          isNull(games.deletedAt)
        )),
        transaction.select().from(steamLibraryItems).where(eq(steamLibraryItems.ownerUserId, ownerUserId))
      ]);
      const gamesById = new Map(localGames.map((game) => [game.id, game]));
      const gamesByAppId = new Map(localGames.filter((game) => game.steamAppId !== null).map((game) => [game.steamAppId!, game]));
      const priorByAppId = new Map(priorItems.map((item) => [item.steamAppId, item]));
      const gamesByNormalizedTitle = new Map<string, typeof localGames>();
      for (const game of localGames) {
        for (const title of [game.nameZh, game.nameEn, ...game.searchAliases]) {
          if (!title) continue;
          for (const variant of gameSearchVariants(title)) {
            const normalized = normalizeSteamTitle(variant);
            if (!normalized) continue;
            const bucket = gamesByNormalizedTitle.get(normalized) ?? [];
            if (!bucket.some((candidate) => candidate.id === game.id)) bucket.push(game);
            gamesByNormalizedTitle.set(normalized, bucket);
          }
        }
      }

      await transaction.update(steamLibraryItems).set({ isOwned: false, updatedAt: now })
        .where(and(eq(steamLibraryItems.ownerUserId, ownerUserId), eq(steamLibraryItems.licenseType, "OWNED")));

      let matched = 0;
      let unmatched = 0;
      let ignored = 0;
      const matchedGameIds = new Set<string>(priorItems.map((item) => item.matchedGameId).filter((value): value is string => Boolean(value)));
      for (const external of owned) {
        const normalizedName = normalizeSteamTitle(external.name);
        const prior = priorByAppId.get(external.appid);
        const appIdMatch = gamesByAppId.get(external.appid);
        const priorManualMatch = prior?.matchStatus === "MATCHED" && prior.matchedGameId
          ? gamesById.get(prior.matchedGameId)
          : undefined;
        const exactCandidates = [...new Map(gameSearchVariants(external.name)
          .flatMap((variant) => gamesByNormalizedTitle.get(normalizeSteamTitle(variant)) ?? [])
          .map((candidate) => [candidate.id, candidate])).values()]
          .filter((candidate) => candidate.steamAppId === null || candidate.steamAppId === external.appid);
        const exactMatch = uniqueSteamNameCandidate(exactCandidates);
        const existing = appIdMatch ?? priorManualMatch ?? exactMatch;
        const lastPlayedAt = external.rtime_last_played ? new Date(external.rtime_last_played * 1000) : null;
        const iconUrl = steamIconUrl(external);

        let matchStatus: "MATCHED" | "UNMATCHED" | "IGNORED";
        let matchedGameId: string | null = null;
        let matchConfidence = 0;
        let matchMethod = exactCandidates.length > 1 ? "AMBIGUOUS_EXACT_TITLE" : "NO_MATCH";

        if (existing) {
          const manuallyConfirmed = prior?.matchedGameId === existing.id && prior.matchMethod.startsWith("MANUAL");
          const englishName = existing.nameEn ? null : steamEnglishNameCandidate(external.name, existing.nameZh);
          const [record] = await transaction.update(games).set({
            steamAppId: existing.steamAppId ?? external.appid,
            lastPlayedAt: latestDate(existing.lastPlayedAt, lastPlayedAt),
            coverUrl: existing.coverUrl ?? iconUrl,
            coverUrlSource: existing.coverUrl ? existing.coverUrlSource : (iconUrl ? "STEAM" : existing.coverUrlSource),
            platform: existing.platform ?? "STEAM",
            platformSource: existing.platform ? existing.platformSource : "STEAM",
            ownershipStatus: "OWNED",
            nameEn: existing.nameEn ?? englishName,
            nameEnSource: existing.nameEn ? existing.nameEnSource : (englishName ? "STEAM" : existing.nameEnSource),
            updatedAt: now,
            version: sql`${games.version} + 1`
          }).where(and(eq(games.id, existing.id), eq(games.ownerUserId, ownerUserId))).returning({ id: games.id });
          if (!record) throw new SteamConnectorError("UPSTREAM_FAILED");
          await transaction.insert(externalGameMappings).values({
            gameId: record.id,
            provider: "STEAM",
            externalGameId: String(external.appid),
            matchConfidence: appIdMatch || priorManualMatch ? 100 : 95,
            manuallyConfirmed
          }).onConflictDoUpdate({
            target: [externalGameMappings.provider, externalGameMappings.externalGameId],
            set: {
              gameId: record.id,
              matchConfidence: appIdMatch || priorManualMatch ? 100 : 95,
              manuallyConfirmed,
              updatedAt: now
            }
          });
          matchStatus = "MATCHED";
          matchedGameId = record.id;
          matchedGameIds.add(record.id);
          matchConfidence = appIdMatch || priorManualMatch ? 100 : 95;
          matchMethod = appIdMatch ? "APP_ID" : priorManualMatch ? prior!.matchMethod : "UNIQUE_EXACT_TITLE";
          gamesByAppId.set(external.appid, existing);
          matched += 1;
        } else if (prior?.matchStatus === "IGNORED") {
          matchStatus = "IGNORED";
          matchMethod = "MANUAL_IGNORE";
          ignored += 1;
        } else {
          matchStatus = "UNMATCHED";
          unmatched += 1;
        }

        await transaction.insert(steamLibraryItems).values({
          ownerUserId,
          steamAppId: external.appid,
          name: external.name,
          normalizedName,
          playtimeMinutes: external.playtime_forever,
          recentPlaytimeMinutes: external.playtime_2weeks ?? null,
          lastPlayedAt,
          iconUrl,
          matchStatus,
          matchedGameId,
          matchConfidence,
          matchMethod,
          licenseType: "OWNED",
          licenseOwnerSteamIds: [account.externalUserId],
          familyGroupId: null,
          excludeReason: null,
          isOwned: true,
          lastSeenJobId: job.id,
          lastSeenAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: [steamLibraryItems.ownerUserId, steamLibraryItems.steamAppId],
          set: {
            name: external.name,
            normalizedName,
            playtimeMinutes: external.playtime_forever,
            recentPlaytimeMinutes: external.playtime_2weeks ?? null,
            lastPlayedAt,
            iconUrl,
            matchStatus,
            matchedGameId,
            matchConfidence,
            matchMethod,
            licenseType: "OWNED",
            licenseOwnerSteamIds: [account.externalUserId],
            familyGroupId: null,
            excludeReason: null,
            isOwned: true,
            lastSeenJobId: job.id,
            lastSeenAt: now,
            updatedAt: now
          }
          });

        if (matchedGameId) {
          await transaction.insert(gameAcquisitions).values({
            ownerUserId,
            gameId: matchedGameId,
            source: "STEAM",
            externalAcquisitionId: String(external.appid),
            channel: "SELF_PURCHASED",
            platform: "STEAM",
            availability: "AVAILABLE",
            isOwned: true,
            details: { steamAppId: external.appid, title: external.name, accessType: "OWNED" },
            lastConfirmedAt: now
          }).onConflictDoUpdate({
            target: [gameAcquisitions.ownerUserId, gameAcquisitions.source, gameAcquisitions.externalAcquisitionId],
            set: {
              gameId: matchedGameId,
              isOwned: true,
              channel: "SELF_PURCHASED",
              platform: "STEAM",
              availability: "AVAILABLE",
              details: { steamAppId: external.appid, title: external.name, accessType: "OWNED" },
              lastConfirmedAt: now,
              updatedAt: now,
              version: sql`${gameAcquisitions.version} + 1`
            }
          });
          const playtimeChanged = !prior || prior.playtimeMinutes !== external.playtime_forever;
          const lastPlayedChanged = (prior?.lastPlayedAt?.getTime() ?? null) !== (lastPlayedAt?.getTime() ?? null);
          if (playtimeChanged || lastPlayedChanged) {
            await transaction.insert(gameActivitySnapshots).values({
              ownerUserId,
              gameId: matchedGameId,
              provider: "STEAM",
              externalGameId: String(external.appid),
              totalPlaytimeMinutes: external.playtime_forever,
              recentPlaytimeMinutes: external.playtime_2weeks ?? null,
              lastPlayedAt,
              observedAt: now
            });
          }
        }
      }

      const ownedExternalIds = owned.map((item) => String(item.appid));
      if (ownedExternalIds.length) {
        await transaction.update(gameAcquisitions).set({ isOwned: false, availability: "TEMPORARILY_UNAVAILABLE", updatedAt: now, version: sql`${gameAcquisitions.version} + 1` }).where(and(
          eq(gameAcquisitions.ownerUserId, ownerUserId),
          eq(gameAcquisitions.source, "STEAM"),
          notInArray(gameAcquisitions.externalAcquisitionId, ownedExternalIds),
          sql`coalesce(${gameAcquisitions.details}->>'accessType', 'OWNED') = 'OWNED'`
        ));
      }

      await recomputeSyncedGameActivity(transaction, ownerUserId, [...matchedGameIds], now);

      await transaction.update(externalAccounts).set({
        lastSyncedAt: now,
        lastErrorCode: null,
        status: "ACTIVE",
        updatedAt: now
      }).where(eq(externalAccounts.id, account.id));
      await transaction.update(syncJobs).set({
        status: unmatched > 0 ? "PARTIAL" : "SUCCEEDED",
        processedCount: owned.length,
        createdCount: 0,
        updatedCount: matched,
        skippedCount: unmatched + ignored,
        summary: {
          reportedGameCount: owned.length,
          matchedCount: matched,
          unmatchedCount: unmatched,
          ignoredCount: ignored
        },
        completedAt: now,
        updatedAt: now
      }).where(eq(syncJobs.id, job.id));
      return { processed: owned.length, matched, unmatched, ignored, created: 0, updated: matched, skipped: unmatched + ignored };
    });
    return { reused: false, jobId: job.id, ...counters };
  } catch (error) {
    const code = error instanceof SteamConnectorError ? error.code : "UPSTREAM_FAILED";
    await db.update(syncJobs).set({ status: "FAILED", errorCode: code, errorMessage: "Steam 同步失败", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    await db.update(externalAccounts).set({ status: "ERROR", lastErrorCode: code, updatedAt: new Date() }).where(eq(externalAccounts.id, account.id));
    throw error;
  }
}
