import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import { externalAccounts, gameMediaItems, games, steamLibraryItems, syncJobs } from "@/server/db/schema";
import { MediaStorageError } from "@/server/media/storage";
import { getExistingSteamMediaIds, saveMediaItem } from "@/server/services/media";

const STEAM_COMMUNITY = "https://steamcommunity.com";
const JINA_READER = "https://r.jina.ai";
const MAX_SCREENSHOTS = 500;
const MAX_INDEX_PAGES = 100;
const SYNC_CONCURRENCY = 3;
const STEAM_REQUEST_INTERVAL_MS = 250;
const STEAM_REQUEST_MAX_ATTEMPTS = 3;
const STEAM_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const READER_REQUEST_INTERVAL_MS = 1000;
const READER_REQUEST_MAX_ATTEMPTS = 3;
const READER_RATE_LIMIT_COOLDOWN_MS = 30_000;

let steamRequestGate = Promise.resolve();
let nextSteamRequestAt = 0;
let steamCommunityDetailBlockedUntil = 0;
let readerRequestGate = Promise.resolve();
let nextReaderRequestAt = 0;

export type SteamScreenshotIndexItem = {
  publishedFileId: string;
  appId: number;
  previewUrl: string | null;
  caption: string | null;
};

export type SteamScreenshotDetail = {
  originalUrl: string;
  caption: string | null;
  postedText: string | null;
  capturedAt: Date | null;
  retrievalMode: "STEAM_HTML" | "JINA_READER";
};

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] ?? null;
}

function normalizeSteamImageUrl(raw: string) {
  const url = new URL(decodeHtml(raw));
  if (url.protocol !== "https:" || !["images.steamusercontent.com", "steamuserimages-a.akamaihd.net"].includes(url.hostname)) {
    throw new MediaStorageError("STEAM_IMAGE_HOST_INVALID", "Steam 截图地址不在允许列表", 502);
  }
  // Legacy Steam UGC objects return 404 without the official image-transform
  // parameters. Keep only Steam's documented image keys and discard anything
  // else before fetching.
  const allowedQueryKeys = new Set(["imw", "imh", "ima", "impolicy", "imcolor", "letterbox"]);
  for (const key of Array.from(url.searchParams.keys())) {
    if (!allowedQueryKeys.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function parseSteamScreenshotPage(html: string): SteamScreenshotIndexItem[] {
  const results: SteamScreenshotIndexItem[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*class=["'][^"']*\bprofile_media_item\b[^"']*["'][^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const publishedFileId = attribute(tag, "data-publishedfileid");
    const appId = Number(attribute(tag, "data-appid"));
    if (!publishedFileId || !Number.isSafeInteger(appId) || appId <= 0 || seen.has(publishedFileId)) continue;
    const blockStart = (match.index ?? 0) + tag.length;
    const blockEnd = html.indexOf("</a>", blockStart);
    const block = html.slice(blockStart, blockEnd === -1 ? blockStart + 8000 : blockEnd);
    const rawImage = block.match(/background-image:\s*url\(["']([^"']+)["']\)/i)?.[1]
      ?? block.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
      ?? null;
    const rawCaption = block.match(/<q\b[^>]*>([\s\S]*?)<\/q>/i)?.[1] ?? null;
    results.push({
      publishedFileId,
      appId,
      previewUrl: rawImage ? normalizeSteamImageUrl(rawImage) : null,
      caption: rawCaption ? decodeHtml(rawCaption) || null : null
    });
    seen.add(publishedFileId);
  }
  return results;
}

const steamMonths: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

const steamFullMonths: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
};

function parsePostedDate(value: string) {
  const match = value.match(/^(\d{1,2})\s+([A-Z][a-z]{2}),\s+(\d{4})\s+@\s+(\d{1,2}):(\d{2})(am|pm)$/);
  const readerMatch = value.match(/^([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+@\s+(\d{1,2}):(\d{2})(am|pm)$/);
  const month = match
    ? steamMonths[match[2]]
    : readerMatch
      ? steamFullMonths[readerMatch[1]] ?? steamMonths[readerMatch[1]]
      : undefined;
  if (month === undefined || (!match && !readerMatch)) return null;
  const day = Number(match?.[1] ?? readerMatch?.[2]);
  const year = Number(match?.[3] ?? readerMatch?.[3]);
  let hour = Number(match?.[4] ?? readerMatch?.[4]);
  const minute = Number(match?.[5] ?? readerMatch?.[5]);
  const meridiem = match?.[6] ?? readerMatch?.[6];
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return new Date(Date.UTC(year, month, day, hour, minute));
}

export function parseSteamScreenshotDetail(html: string): SteamScreenshotDetail {
  const rawOriginal = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*<img\b[^>]*id=["']ActualMedia["']/i)?.[1]
    ?? html.match(/<img\b[^>]*id=["']ActualMedia["'][^>]*src=["']([^"']+)["']/i)?.[1];
  if (!rawOriginal) throw new MediaStorageError("STEAM_SCREENSHOT_DETAIL_INVALID", "Steam 截图详情缺少原图", 502);
  const detailValues = Array.from(html.matchAll(/<div\b[^>]*class=["'][^"']*detailsStatRight[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi))
    .map((match) => decodeHtml(match[1]));
  const postedText = detailValues.find((value) => /\d{1,2}\s+[A-Z][a-z]{2},\s+\d{4}\s+@/.test(value)) ?? null;
  const rawCaption = html.match(/<div\b[^>]*class=["'][^"']*screenshotDescription[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? null;
  return {
    originalUrl: normalizeSteamImageUrl(rawOriginal),
    caption: rawCaption ? decodeHtml(rawCaption).replace(/^"|"$/g, "").trim() || null : null,
    postedText,
    capturedAt: postedText ? parsePostedDate(postedText) : null,
    retrievalMode: "STEAM_HTML"
  };
}

export function parseSteamScreenshotMarkdown(markdown: string): SteamScreenshotDetail {
  const imageUrls = Array.from(markdown.matchAll(/https:\/\/(?:images\.steamusercontent\.com|steamuserimages-a\.akamaihd\.net)\/[^\s)]+/gi))
    .map((match) => match[0].replace(/[\],.]+$/, ""));
  const rawOriginal = imageUrls.find((url) => /(?:\?|&)imw=5000(?:&|$)/.test(url) && /(?:\?|&)letterbox=false(?:&|$)/.test(url))
    ?? imageUrls.find((url) => /(?:\?|&)imw=5000(?:&|$)/.test(url));
  if (!rawOriginal) throw new MediaStorageError("STEAM_SCREENSHOT_READER_INVALID", "网页读取结果缺少 Steam 原图", 502);
  const postedText = markdown.match(/(?:^|\r?\n)([A-Z][a-z]+\s+\d{1,2},\s+\d{4}\s+@\s+\d{1,2}:\d{2}(?:am|pm))(?:\r?\n|$)/m)?.[1] ?? null;
  return {
    originalUrl: normalizeSteamImageUrl(rawOriginal),
    caption: null,
    postedText,
    capturedAt: postedText ? parsePostedDate(postedText) : null,
    retrievalMode: "JINA_READER"
  };
}

async function waitForSteamRequestSlot() {
  let release = () => {};
  const previous = steamRequestGate;
  steamRequestGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextSteamRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextSteamRequestAt = Date.now() + STEAM_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

async function waitForReaderRequestSlot() {
  let release = () => {};
  const previous = readerRequestGate;
  readerRequestGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextReaderRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextReaderRequestAt = Date.now() + READER_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

async function readerFetch(detailUrl: string) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < READER_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    await waitForReaderRequestSlot();
    try {
      const response = await fetch(`${JINA_READER}/${detailUrl}`, {
        signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS),
        headers: {
          accept: "text/plain",
          "user-agent": "Mozilla/5.0 game-inventory-media-sync/0.20.5"
        }
      });
      if (response.ok) return response;
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status === 429 && attempt < READER_REQUEST_MAX_ATTEMPTS - 1) {
        nextReaderRequestAt = Math.max(nextReaderRequestAt, Date.now() + READER_RATE_LIMIT_COOLDOWN_MS);
        continue;
      }
      if (response.status >= 500 && attempt < READER_REQUEST_MAX_ATTEMPTS - 1) {
        nextReaderRequestAt = Math.max(nextReaderRequestAt, Date.now() + 2000 * 2 ** attempt);
        continue;
      }
      break;
    } catch {
      if (attempt === READER_REQUEST_MAX_ATTEMPTS - 1) break;
      nextReaderRequestAt = Math.max(nextReaderRequestAt, Date.now() + 2000 * 2 ** attempt);
    }
  }
  const detail = lastStatus ? `HTTP ${lastStatus}` : "网络请求失败";
  throw new MediaStorageError("STEAM_SCREENSHOT_READER_FAILED", `网页读取服务失败：${detail}`, 502);
}

function retryDelayMs(response: Response, attempt: number) {
  const rawRetryAfter = response.headers.get("retry-after");
  const seconds = rawRetryAfter ? Number(rawRetryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  if (rawRetryAfter) {
    const retryAt = Date.parse(rawRetryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), 5000);
  }
  return Math.min(500 * 2 ** attempt, 2000);
}

async function steamFetch(url: string, init?: RequestInit, maxAttempts = STEAM_REQUEST_MAX_ATTEMPTS) {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await waitForSteamRequestSlot();
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 game-inventory-media-sync/0.20.2",
          ...init?.headers
        }
      });
      if (response.ok) return response;
      lastFailure = new MediaStorageError(
        "STEAM_SCREENSHOT_FETCH_FAILED",
        `Steam 返回 HTTP ${response.status}（第 ${attempt + 1}/${maxAttempts} 次）`,
        502
      );
      if (!STEAM_RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts - 1) throw lastFailure;
      await response.body?.cancel();
      const delay = retryDelayMs(response, attempt);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      if (error instanceof MediaStorageError) throw error;
      lastFailure = error;
      if (attempt === maxAttempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2000)));
    }
  }
  const detail = lastFailure instanceof Error ? lastFailure.message : "未知网络错误";
  throw new MediaStorageError("STEAM_SCREENSHOT_FETCH_FAILED", `Steam 请求失败：${detail}`, 502);
}

export async function fetchSteamScreenshotIndex(steamId: string) {
  const baseUrl = `${STEAM_COMMUNITY}/profiles/${encodeURIComponent(steamId)}/screenshots/`;
  const items: SteamScreenshotIndexItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_INDEX_PAGES && items.length < MAX_SCREENSHOTS; page += 1) {
    const response = page === 1
      ? await steamFetch(baseUrl)
      : await steamFetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            appid: "0",
            p: String(page),
            privacy: "30",
            content: "1",
            browsefilter: "myfiles",
            sort: "newestfirst",
            view: "imagewall"
          })
        });
    const pageItems = parseSteamScreenshotPage(await response.text());
    const unseen = pageItems.filter((item) => !seen.has(item.publishedFileId));
    for (const item of unseen) {
      seen.add(item.publishedFileId);
      items.push(item);
      if (items.length >= MAX_SCREENSHOTS) break;
    }
    if (!pageItems.length || !unseen.length) break;
  }
  return items;
}

export async function fetchSteamScreenshotDetail(publishedFileId: string) {
  const detailUrl = `${STEAM_COMMUNITY}/sharedfiles/filedetails/?id=${encodeURIComponent(publishedFileId)}`;
  if (Date.now() >= steamCommunityDetailBlockedUntil) {
    try {
      const response = await steamFetch(detailUrl, undefined, 1);
      return parseSteamScreenshotDetail(await response.text());
    } catch (error) {
      if (error instanceof Error && /HTTP 429/.test(error.message)) {
        steamCommunityDetailBlockedUntil = Date.now() + 10 * 60 * 1000;
      }
    }
  }
  const response = await readerFetch(detailUrl);
  return parseSteamScreenshotMarkdown(await response.text());
}

async function downloadSteamImage(url: string) {
  normalizeSteamImageUrl(url);
  const response = await steamFetch(url);
  // fetch() follows redirects, so validate the terminal URL as well as the
  // listing-provided URL before consuming response bytes.
  normalizeSteamImageUrl(response.url);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > env().MEDIA_MAX_UPLOAD_BYTES) {
    throw new MediaStorageError("MEDIA_TOO_LARGE", "Steam 截图超过单图上限", 413);
  }
  if (!response.body) throw new MediaStorageError("STEAM_IMAGE_EMPTY", "Steam 截图响应为空", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > env().MEDIA_MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new MediaStorageError("MEDIA_TOO_LARGE", "Steam 截图超过单图上限", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function mapWithConcurrency<T>(items: T[], worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(SYNC_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

export async function syncSteamScreenshots(ownerUserId: string, requestId: string, rawIdempotencyKey?: string) {
  const [account] = await db.select().from(externalAccounts).where(and(
    eq(externalAccounts.ownerUserId, ownerUserId),
    eq(externalAccounts.provider, "STEAM"),
    eq(externalAccounts.status, "ACTIVE")
  )).limit(1);
  if (!account) throw new MediaStorageError("STEAM_ACCOUNT_REQUIRED", "请先在同步中心配置 Steam 账号", 409);

  const idempotencyKey = `steam-screenshots:${rawIdempotencyKey?.trim() || randomUUID()}`.slice(0, 200);
  const inserted = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "STEAM",
    status: "RUNNING",
    idempotencyKey,
    startedAt: new Date(),
    summary: { kind: "SCREENSHOTS" }
  }).onConflictDoNothing({ target: [syncJobs.ownerUserId, syncJobs.idempotencyKey] }).returning();
  if (!inserted[0]) {
    const [existing] = await db.select().from(syncJobs).where(and(
      eq(syncJobs.ownerUserId, ownerUserId),
      eq(syncJobs.idempotencyKey, idempotencyKey)
    )).limit(1);
    return { job: existing, reused: true };
  }
  const job = inserted[0];

  try {
    const index = await fetchSteamScreenshotIndex(account.externalUserId);
    const existingIds = await getExistingSteamMediaIds(ownerUserId, index.map((item) => item.publishedFileId));
    const candidates = index.filter((item) => !existingIds.has(item.publishedFileId));
    const appIds = Array.from(new Set(candidates.map((item) => item.appId)));
    const [directGames, mappedGames] = await Promise.all([
      appIds.length ? db.select({ appId: games.steamAppId, gameId: games.id }).from(games).where(and(
        eq(games.ownerUserId, ownerUserId),
        isNull(games.deletedAt),
        inArray(games.steamAppId, appIds)
      )) : [],
      appIds.length ? db.select({ appId: steamLibraryItems.steamAppId, gameId: steamLibraryItems.matchedGameId }).from(steamLibraryItems).where(and(
        eq(steamLibraryItems.ownerUserId, ownerUserId),
        eq(steamLibraryItems.matchStatus, "MATCHED"),
        inArray(steamLibraryItems.steamAppId, appIds)
      )) : []
    ]);
    const gameByAppId = new Map<number, string>();
    for (const row of mappedGames) if (row.gameId) gameByAppId.set(row.appId, row.gameId);
    for (const row of directGames) if (row.appId) gameByAppId.set(row.appId, row.gameId);

    let createdCount = 0;
    let duplicateCount = existingIds.size;
    let unmatchedCount = 0;
    let failedCount = 0;
    const errors: Array<{ publishedFileId: string; code: string; message: string }> = [];
    await mapWithConcurrency(candidates, async (item) => {
      const gameId = gameByAppId.get(item.appId);
      if (!gameId) {
        unmatchedCount += 1;
        return;
      }
      try {
        const detail = await fetchSteamScreenshotDetail(item.publishedFileId);
        const bytes = await downloadSteamImage(detail.originalUrl);
        const saved = await saveMediaItem({
          gameId,
          source: "STEAM",
          externalMediaId: item.publishedFileId,
          sourceUrl: `${STEAM_COMMUNITY}/sharedfiles/filedetails/?id=${item.publishedFileId}`,
          title: detail.caption ?? item.caption ?? undefined,
          capturedAt: detail.capturedAt ?? undefined,
          originalName: `steam-${item.publishedFileId}.jpg`,
          bytes,
          sourceMetadata: {
            steamAppId: item.appId,
            publishedFileId: item.publishedFileId,
            postedText: detail.postedText,
            detailRetrievalMode: detail.retrievalMode,
            profileSteamId: account.externalUserId
          }
        }, ownerUserId, `${requestId}:${item.publishedFileId}`.slice(0, 100));
        if (saved.created) createdCount += 1;
        else duplicateCount += 1;
      } catch (error) {
        failedCount += 1;
        errors.push({
          publishedFileId: item.publishedFileId,
          code: error instanceof MediaStorageError ? error.code : "STEAM_SCREENSHOT_IMPORT_FAILED",
          message: error instanceof Error ? error.message.slice(0, 200) : "未知导入错误"
        });
      }
    });

    let dateBackfilledCount = 0;
    let dateBackfillSkippedCount = 0;
    let dateBackfillFailedCount = 0;
    const dateBackfillErrors: Array<{ publishedFileId: string; code: string; message: string }> = [];
    const missingDateItems = index.length ? await db.select({
      id: gameMediaItems.id,
      externalMediaId: gameMediaItems.externalMediaId,
      sourceMetadata: gameMediaItems.sourceMetadata
    }).from(gameMediaItems).where(and(
      eq(gameMediaItems.ownerUserId, ownerUserId),
      eq(gameMediaItems.source, "STEAM"),
      isNull(gameMediaItems.deletedAt),
      isNull(gameMediaItems.capturedAt),
      inArray(gameMediaItems.externalMediaId, index.map((item) => item.publishedFileId))
    )) : [];
    await mapWithConcurrency(missingDateItems, async (item) => {
      if (!item.externalMediaId) return;
      try {
        const detail = await fetchSteamScreenshotDetail(item.externalMediaId);
        if (!detail.capturedAt) {
          dateBackfillSkippedCount += 1;
          return;
        }
        const updated = await db.update(gameMediaItems).set({
          capturedAt: detail.capturedAt,
          sourceMetadata: {
            ...item.sourceMetadata,
            capturedAtBackfillRetrievalMode: detail.retrievalMode
          },
          updatedAt: new Date()
        }).where(and(
          eq(gameMediaItems.id, item.id),
          eq(gameMediaItems.ownerUserId, ownerUserId),
          isNull(gameMediaItems.capturedAt)
        )).returning({ id: gameMediaItems.id });
        if (updated[0]) dateBackfilledCount += 1;
      } catch (error) {
        dateBackfillFailedCount += 1;
        dateBackfillErrors.push({
          publishedFileId: item.externalMediaId,
          code: error instanceof MediaStorageError ? error.code : "STEAM_SCREENSHOT_DATE_BACKFILL_FAILED",
          message: error instanceof Error ? error.message.slice(0, 200) : "未知日期回填错误"
        });
      }
    });

    const summary = {
      kind: "SCREENSHOTS",
      discoveredCount: index.length,
      candidateCount: candidates.length,
      createdCount,
      duplicateCount,
      unmatchedCount,
      failedCount,
      dateBackfilledCount,
      dateBackfillSkippedCount,
      dateBackfillFailedCount,
      truncated: index.length >= MAX_SCREENSHOTS,
      errors: errors.slice(0, 20),
      dateBackfillErrors: dateBackfillErrors.slice(0, 20)
    };
    const totalFailedCount = failedCount + dateBackfillFailedCount;
    const [completed] = await db.update(syncJobs).set({
      status: totalFailedCount ? "PARTIAL" : "SUCCEEDED",
      processedCount: index.length,
      createdCount,
      updatedCount: dateBackfilledCount,
      skippedCount: duplicateCount + unmatchedCount,
      errorCode: totalFailedCount ? "STEAM_SCREENSHOTS_PARTIAL" : null,
      errorMessage: totalFailedCount ? `${failedCount} 张截图导入失败，${dateBackfillFailedCount} 张日期回填失败` : null,
      summary,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id)).returning();
    return { job: completed, summary, reused: false };
  } catch (error) {
    const code = error instanceof MediaStorageError ? error.code : "STEAM_SCREENSHOT_SYNC_FAILED";
    await db.update(syncJobs).set({
      status: "FAILED",
      errorCode: code,
      errorMessage: "Steam 截图同步失败",
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    throw error;
  }
}
