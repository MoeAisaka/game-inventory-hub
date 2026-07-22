import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/server/db";
import {
  gameFieldLocks,
  gameMetadataCandidates,
  gameReleaseEvents,
  games,
  platformLibraryItems,
  syncJobs
} from "@/server/db/schema";

type Fetcher = typeof fetch;
type StoreIdentifier = { conceptId?: string; productId?: string };
type JsonRecord = Record<string, unknown>;

const batchLimit = 6;
const storeLocales = ["en-hk", "en-us", "en-gb", "ja-jp"] as const;
const localeTimeZones: Record<(typeof storeLocales)[number], string> = {
  "en-hk": "Asia/Hong_Kong",
  "en-us": "America/Los_Angeles",
  "en-gb": "Europe/London",
  "ja-jp": "Asia/Tokyo"
};

export class PlayStationStoreConnectorError extends Error {
  constructor(public readonly code: "UPSTREAM_FAILED" | "METADATA_UNAVAILABLE") {
    super(code);
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function refId(value: unknown, prefix: string) {
  const ref = text(record(value)?.__ref);
  if (!ref?.startsWith(`${prefix}:`)) return null;
  return ref.slice(prefix.length + 1).split(":")[0] || null;
}

function identifierKey(identifier: StoreIdentifier) {
  if (identifier.conceptId) return `concept:${identifier.conceptId}`;
  if (identifier.productId) return `product:${identifier.productId}`;
  throw new PlayStationStoreConnectorError("METADATA_UNAVAILABLE");
}

function storeUrl(locale: string, identifier: StoreIdentifier) {
  if (identifier.conceptId) return `https://store.playstation.com/${locale}/concept/${encodeURIComponent(identifier.conceptId)}`;
  if (identifier.productId) return `https://store.playstation.com/${locale}/product/${encodeURIComponent(identifier.productId)}`;
  throw new PlayStationStoreConnectorError("METADATA_UNAVAILABLE");
}

function dateValue(value: unknown) {
  if (typeof value === "string") return value;
  return text(record(value)?.value);
}

function datePrecision(value: unknown) {
  const type = text(record(value)?.type);
  if (type === "YEAR") return "YEAR" as const;
  if (type === "MONTH_YEAR") return "MONTH" as const;
  if (type?.includes("QUARTER")) return "QUARTER" as const;
  return "DAY" as const;
}

function localDate(value: string | null, timeZone: string) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function cleanPlayStationStoreName(value: string | null) {
  if (!value) return null;
  const languageWords = "Chinese|English|Japanese|Korean|French|German|Spanish|Italian|Portuguese|Russian|Polish|Arabic|Thai|Turkish|Dutch|Finnish|Swedish|Danish|Norwegian|Czech|Hungarian|Romanian|Vietnamese|Indonesian";
  return value.replace(new RegExp(`\\s*\\((?=[^)]*(?:${languageWords}))[^)]*\\)\\s*$`, "i"), "").trim() || null;
}

function collectCacheEntities(html: string) {
  const entities = new Map<string, JsonRecord[]>();
  const scripts = html.matchAll(/<script(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = record(JSON.parse(match[1]));
      const cache = record(parsed?.cache);
      if (!cache) continue;
      for (const [key, value] of Object.entries(cache)) {
        const entity = record(value);
        if (!entity || (!key.startsWith("Concept:") && !key.startsWith("Product:"))) continue;
        entities.set(key, [...(entities.get(key) ?? []), entity]);
      }
    } catch {
      // Individual page fragments are optional; only well-formed JSON caches are used.
    }
  }
  return entities;
}

function entitiesFor(entities: Map<string, JsonRecord[]>, prefix: string, id: string | null) {
  if (!id) return [];
  return [...entities.entries()].filter(([key]) => key === `${prefix}:${id}` || key.startsWith(`${prefix}:${id}:`))
    .flatMap(([, values]) => values);
}

function firstValue<T>(values: T[]) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

export function parsePlayStationStoreHtml(html: string, identifier: StoreIdentifier, locale: (typeof storeLocales)[number] = "en-hk") {
  const entities = collectCacheEntities(html);
  let conceptId = identifier.conceptId ?? null;
  let productId = identifier.productId ?? null;
  let products = entitiesFor(entities, "Product", productId);
  if (!conceptId) conceptId = firstValue(products.map((product) => refId(product.concept, "Concept")));
  let concepts = entitiesFor(entities, "Concept", conceptId);
  if (!productId) productId = firstValue(concepts.map((concept) => refId(concept.defaultProduct, "Product")));
  products = entitiesFor(entities, "Product", productId);
  if (!conceptId) conceptId = firstValue(products.map((product) => refId(product.concept, "Concept")));
  concepts = entitiesFor(entities, "Concept", conceptId);

  const productSpecific = Boolean(identifier.productId && !identifier.conceptId);
  const conceptRelease = firstValue(concepts.map((concept) => dateValue(concept.releaseDate)));
  const productRelease = firstValue(products.map((product) => dateValue(product.releaseDate)));
  const releaseValue = productSpecific ? productRelease ?? conceptRelease : conceptRelease ?? productRelease;
  const conceptReleaseObject = concepts.map((concept) => concept.releaseDate).find((value) => dateValue(value) === conceptRelease);
  const nameEn = cleanPlayStationStoreName(
    productSpecific
      ? firstValue(products.map((product) => text(product.name))) ?? firstValue(concepts.map((concept) => text(concept.name)))
      : firstValue(concepts.map((concept) => text(concept.name))) ?? firstValue(products.map((product) => text(product.name)))
  );
  const classification = firstValue(products.map((product) => text(product.storeDisplayClassification)));
  const rating = firstValue(products.map((product) => record(product.starRating)));
  const averageRating = typeof rating?.averageRating === "number" ? rating.averageRating : null;
  const totalRatingsCount = typeof rating?.totalRatingsCount === "number" ? rating.totalRatingsCount : null;
  const releaseDate = localDate(releaseValue, localeTimeZones[locale]);
  if (!nameEn && !releaseDate) return null;
  const resolvedIdentifier = { conceptId: conceptId ?? undefined, productId: productId ?? undefined };
  return {
    conceptId,
    productId,
    nameEn,
    releaseDate,
    datePrecision: !productSpecific && conceptRelease ? datePrecision(conceptReleaseObject) : "DAY" as const,
    classification,
    communityRating: averageRating === null ? null : Math.round(averageRating * 2000) / 100,
    communityRatingCount: totalRatingsCount,
    storeUrl: storeUrl(locale, identifier.conceptId || identifier.productId ? identifier : resolvedIdentifier),
    locale
  };
}

export function playStationStoreIdentifier(rawMetadata: Record<string, unknown>, externalGameId: string): StoreIdentifier | null {
  const rawConcept = rawMetadata.conceptId;
  const rawProduct = rawMetadata.productId;
  const conceptId = rawConcept === null || rawConcept === undefined || String(rawConcept) === "null"
    ? (externalGameId.startsWith("concept:") ? externalGameId.slice(8) : undefined)
    : String(rawConcept);
  const productId = rawProduct === null || rawProduct === undefined || String(rawProduct) === "null"
    ? (externalGameId.startsWith("product:") ? externalGameId.slice(8) : undefined)
    : String(rawProduct);
  return conceptId || productId ? { conceptId, productId } : null;
}

export async function fetchPlayStationStoreMetadata(identifier: StoreIdentifier, fetcher: Fetcher = fetch) {
  let upstreamReached = false;
  for (const locale of storeLocales) {
    const url = storeUrl(locale, identifier);
    try {
      const response = await fetcher(url, {
        headers: { "user-agent": "GameInventory/0.34.0 (+https://games.example.invalid)" },
        signal: AbortSignal.timeout(env().EXTERNAL_REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) continue;
      upstreamReached = true;
      const parsed = parsePlayStationStoreHtml(await response.text(), identifier, locale);
      if (parsed) return parsed;
    } catch {
      // Try the next official store locale before marking the item unavailable.
    }
  }
  throw new PlayStationStoreConnectorError(upstreamReached ? "METADATA_UNAVAILABLE" : "UPSTREAM_FAILED");
}

export async function syncPlayStationStoreMetadata(
  ownerUserId: string,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
  options: { retryBefore?: Date } = {}
) {
  const [createdJob] = await db.insert(syncJobs).values({
    ownerUserId,
    provider: "PLAYSTATION",
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
      db.select({ item: platformLibraryItems, game: games }).from(platformLibraryItems)
        .innerJoin(games, eq(games.id, platformLibraryItems.matchedGameId))
        .where(and(
          eq(platformLibraryItems.ownerUserId, ownerUserId),
          eq(platformLibraryItems.provider, "PLAYSTATION"),
          eq(platformLibraryItems.matchStatus, "MATCHED"),
          isNull(games.deletedAt),
          or(isNull(games.nameEn), isNull(games.releaseDate))
        )).orderBy(desc(platformLibraryItems.playtimeMinutes), desc(platformLibraryItems.lastSeenAt)),
      db.select({ gameId: gameMetadataCandidates.gameId, fetchedAt: gameMetadataCandidates.fetchedAt })
        .from(gameMetadataCandidates).where(and(
          eq(gameMetadataCandidates.ownerUserId, ownerUserId),
          eq(gameMetadataCandidates.provider, "PLAYSTATION")
        ))
    ]);
    const latestFetched = new Map<string, number>();
    for (const candidate of priorCandidates) {
      latestFetched.set(candidate.gameId, Math.max(latestFetched.get(candidate.gameId) ?? 0, candidate.fetchedAt.getTime()));
    }
    const staleBefore = (options.retryBefore ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)).getTime();
    const selected: Array<(typeof mappedRows)[number] & { identifier: StoreIdentifier }> = [];
    const seenGames = new Set<string>();
    for (const row of mappedRows) {
      if (seenGames.has(row.game.id) || (latestFetched.get(row.game.id) ?? 0) >= staleBefore) continue;
      const identifier = playStationStoreIdentifier(row.item.rawMetadata, row.item.externalGameId);
      if (!identifier) continue;
      seenGames.add(row.game.id);
      selected.push({ ...row, identifier });
      if (selected.length === batchLimit) break;
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let releaseDatesUpdated = 0;
    let englishNamesUpdated = 0;
    for (const row of selected) {
      const externalId = identifierKey(row.identifier);
      try {
        const metadata = await fetchPlayStationStoreMetadata(row.identifier, fetcher);
        await db.transaction(async (transaction) => {
          const locks = new Set((await transaction.select({ field: gameFieldLocks.field })
            .from(gameFieldLocks).where(eq(gameFieldLocks.gameId, row.game.id))).map((lock) => lock.field));
          const patch: Record<string, unknown> = { updatedAt: new Date() };
          const applied = new Set<string>();
          if (!row.game.nameEn && metadata.nameEn && !locks.has("NAME_EN")) {
            patch.nameEn = metadata.nameEn;
            patch.nameEnSource = "PLAYSTATION";
            applied.add("NAME_EN");
            englishNamesUpdated += 1;
          }
          if (!row.game.releaseDate && metadata.releaseDate && !locks.has("RELEASE_DATE")) {
            patch.releaseDate = metadata.releaseDate;
            patch.releaseDateSource = "PLAYSTATION";
            applied.add("RELEASE_DATE");
            releaseDatesUpdated += 1;
          }
          if (applied.size) {
            patch.version = sql`${games.version} + 1`;
            await transaction.update(games).set(patch).where(eq(games.id, row.game.id));
          }
          const candidates = [
            ["NAME_EN", row.game.nameEn === null, metadata.nameEn, "PlayStation Store 英文名"],
            ["RELEASE_DATE", row.game.releaseDate === null, metadata.releaseDate, "PlayStation Store 推出日"]
          ] as const;
          for (const [field, wasMissing, value, sourceLabel] of candidates) {
            if (!wasMissing) continue;
            const wasApplied = applied.has(field);
            await transaction.insert(gameMetadataCandidates).values({
              ownerUserId,
              gameId: row.game.id,
              provider: "PLAYSTATION",
              externalGameId: externalId,
              field,
              value: {
                value,
                sourceUrl: metadata.storeUrl,
                sourceLabel,
                metadata: {
                  classification: metadata.classification,
                  datePrecision: field === "RELEASE_DATE" ? metadata.datePrecision : undefined,
                  locale: metadata.locale
                }
              },
              confidence: value === null ? 0 : 100,
              status: wasApplied ? "APPLIED" : "PENDING",
              appliedAt: wasApplied ? new Date() : null,
              fetchedAt: new Date()
            }).onConflictDoUpdate({
              target: [gameMetadataCandidates.gameId, gameMetadataCandidates.provider, gameMetadataCandidates.externalGameId, gameMetadataCandidates.field],
              set: {
                value: {
                  value,
                  sourceUrl: metadata.storeUrl,
                  sourceLabel,
                  metadata: {
                    classification: metadata.classification,
                    datePrecision: field === "RELEASE_DATE" ? metadata.datePrecision : undefined,
                    locale: metadata.locale
                  }
                },
                confidence: value === null ? 0 : 100,
                status: wasApplied ? "APPLIED" : "PENDING",
                appliedAt: wasApplied ? new Date() : null,
                fetchedAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
          if (applied.has("RELEASE_DATE") && metadata.releaseDate) {
            const dedupeKey = `game:${row.game.id}:playstation-store`;
            await transaction.insert(gameReleaseEvents).values({
              ownerUserId,
              gameId: row.game.id,
              source: "PLAYSTATION",
              dedupeKey,
              externalGameId: externalId,
              nameZh: row.game.nameZh,
              nameEn: metadata.nameEn ?? row.game.nameEn,
              platform: row.game.platform ?? "PLAYSTATION",
              releaseDate: metadata.releaseDate,
              datePrecision: metadata.datePrecision,
              region: "ASIA",
              storeUrl: metadata.storeUrl,
              coverUrl: row.game.coverUrl
            }).onConflictDoUpdate({
              target: [gameReleaseEvents.ownerUserId, gameReleaseEvents.dedupeKey],
              set: {
                externalGameId: externalId,
                nameZh: row.game.nameZh,
                nameEn: metadata.nameEn ?? row.game.nameEn,
                platform: row.game.platform ?? "PLAYSTATION",
                releaseDate: metadata.releaseDate,
                datePrecision: metadata.datePrecision,
                region: "ASIA",
                storeUrl: metadata.storeUrl,
                coverUrl: row.game.coverUrl,
                fetchedAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
          if (applied.size) updated += 1;
          else skipped += 1;
        });
      } catch {
        failed += 1;
        await db.insert(gameMetadataCandidates).values({
          ownerUserId,
          gameId: row.game.id,
          provider: "PLAYSTATION",
          externalGameId: externalId,
          field: "RELEASE_DATE",
          value: { value: null, sourceUrl: storeUrl("en-hk", row.identifier), sourceLabel: "PlayStation Store 元数据暂不可用" },
          confidence: 0,
          status: "PENDING",
          fetchedAt: new Date()
        }).onConflictDoUpdate({
          target: [gameMetadataCandidates.gameId, gameMetadataCandidates.provider, gameMetadataCandidates.externalGameId, gameMetadataCandidates.field],
          set: {
            value: { value: null, sourceUrl: storeUrl("en-hk", row.identifier), sourceLabel: "PlayStation Store 元数据暂不可用" },
            confidence: 0,
            status: "PENDING",
            fetchedAt: new Date(),
            updatedAt: new Date()
          }
        });
      }
    }
    const hasMore = selected.length === batchLimit;
    await db.update(syncJobs).set({
      status: failed || skipped ? "PARTIAL" : "SUCCEEDED",
      processedCount: selected.length,
      updatedCount: updated,
      skippedCount: skipped + failed,
      summary: {
        batchLimit,
        hasMore,
        source: "PLAYSTATION_OFFICIAL_STORE",
        exactPlatformIdentifierOnly: true,
        releaseDatesUpdated,
        englishNamesUpdated,
        failed
      },
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    return { reused: false, jobId: job.id, processed: selected.length, updated, skipped, failed, releaseDatesUpdated, englishNamesUpdated, hasMore };
  } catch (error) {
    await db.update(syncJobs).set({
      status: "FAILED",
      errorCode: error instanceof PlayStationStoreConnectorError ? error.code : "UPSTREAM_FAILED",
      errorMessage: "PlayStation Store 元数据同步失败",
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(syncJobs.id, job.id));
    throw error;
  }
}
