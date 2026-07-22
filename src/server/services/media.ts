import { and, asc, count, countDistinct, desc, eq, ilike, inArray, isNull, or, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { auditLogs, fileBlobs, gameMediaItems, games } from "@/server/db/schema";
import { MediaStorageError, readStoredContent, storeImage, type StoredImage } from "@/server/media/storage";

const optionalUuid = z.preprocess((value) => value === "" ? undefined : value, z.string().uuid().optional());

export const mediaQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  gameId: optionalUuid,
  source: z.preprocess((value) => value === "" ? undefined : value, z.enum(["MANUAL", "STEAM"]).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(120).default(60)
});

export const manualMediaSchema = z.object({
  gameId: z.string().uuid(),
  title: z.string().trim().max(500).optional(),
  capturedAt: z.preprocess((value) => value === "" ? undefined : value, z.iso.datetime().optional())
});

export type SaveMediaInput = {
  gameId: string;
  source: "MANUAL" | "STEAM";
  externalMediaId?: string;
  sourceUrl?: string;
  title?: string;
  capturedAt?: Date;
  originalName: string;
  bytes: Buffer;
  sourceMetadata?: Record<string, unknown>;
};

function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

async function upsertBlob(stored: StoredImage["original"] | StoredImage["thumbnail"], actorUserId: string) {
  const [blob] = await db.insert(fileBlobs).values({
    checksumSha256: stored.checksumSha256,
    originalName: stored.originalName,
    mimeType: stored.mimeType,
    byteSize: stored.byteSize,
    storagePath: stored.relativePath,
    status: "READY",
    createdByUserId: actorUserId
  }).onConflictDoUpdate({
    target: fileBlobs.checksumSha256,
    set: { storagePath: stored.relativePath, status: "READY" }
  }).returning();
  return blob;
}

export async function saveMediaItem(input: SaveMediaInput, actorUserId: string, requestId: string) {
  const [game] = await db.select({ id: games.id }).from(games).where(and(
    eq(games.id, input.gameId),
    eq(games.ownerUserId, actorUserId),
    isNull(games.deletedAt)
  )).limit(1);
  if (!game) throw new MediaStorageError("GAME_NOT_FOUND", "游戏不存在", 404);

  if (input.source === "STEAM" && input.externalMediaId) {
    const [existingExternal] = await db.select({ id: gameMediaItems.id }).from(gameMediaItems).where(and(
      eq(gameMediaItems.ownerUserId, actorUserId),
      eq(gameMediaItems.source, "STEAM"),
      eq(gameMediaItems.externalMediaId, input.externalMediaId)
    )).limit(1);
    if (existingExternal) return { id: existingExternal.id, created: false, duplicate: "external-id" as const };
  }

  const stored = await storeImage(input.bytes, input.originalName);
  const [originalBlob, thumbnailBlob] = await Promise.all([
    upsertBlob(stored.original, actorUserId),
    upsertBlob(stored.thumbnail, actorUserId)
  ]);

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: gameMediaItems.id, deletedAt: gameMediaItems.deletedAt })
      .from(gameMediaItems)
      .where(and(eq(gameMediaItems.ownerUserId, actorUserId), eq(gameMediaItems.originalBlobId, originalBlob.id)))
      .limit(1);
    if (existing) {
      if (existing.deletedAt) {
        await tx.update(gameMediaItems).set({
          gameId: input.gameId,
          thumbnailBlobId: thumbnailBlob.id,
          source: input.source,
          externalMediaId: input.externalMediaId,
          sourceUrl: input.sourceUrl,
          title: input.title || null,
          capturedAt: input.capturedAt,
          width: stored.width,
          height: stored.height,
          sourceMetadata: input.sourceMetadata ?? {},
          deletedAt: null,
          updatedAt: new Date()
        }).where(eq(gameMediaItems.id, existing.id));
      }
      return { id: existing.id, created: false, duplicate: "content" as const, restored: Boolean(existing.deletedAt) };
    }

    const [media] = await tx.insert(gameMediaItems).values({
      ownerUserId: actorUserId,
      gameId: input.gameId,
      originalBlobId: originalBlob.id,
      thumbnailBlobId: thumbnailBlob.id,
      source: input.source,
      externalMediaId: input.externalMediaId,
      sourceUrl: input.sourceUrl,
      title: input.title || null,
      capturedAt: input.capturedAt,
      width: stored.width,
      height: stored.height,
      sourceMetadata: input.sourceMetadata ?? {}
    }).returning();
    await tx.insert(auditLogs).values({
      actorUserId,
      action: input.source === "STEAM" ? "media.steam.import" : "media.manual.upload",
      entityType: "game_media",
      entityId: media.id,
      outcome: "SUCCESS",
      requestId,
      metadata: {
        gameId: input.gameId,
        source: input.source,
        externalMediaId: input.externalMediaId ?? null,
        checksumSha256: stored.original.checksumSha256,
        byteSize: stored.original.byteSize
      }
    });
    return { id: media.id, created: true };
  });
}

export async function createManualMedia(
  raw: z.infer<typeof manualMediaSchema>,
  file: { name: string; bytes: Buffer },
  actorUserId: string,
  requestId: string
) {
  const input = manualMediaSchema.parse(raw);
  return saveMediaItem({
    gameId: input.gameId,
    source: "MANUAL",
    title: input.title,
    capturedAt: input.capturedAt ? new Date(input.capturedAt) : undefined,
    originalName: file.name,
    bytes: file.bytes
  }, actorUserId, requestId);
}

export async function listMediaLibrary(ownerUserId: string, raw: z.input<typeof mediaQuerySchema>) {
  const query = mediaQuerySchema.parse(raw);
  const conditions = [eq(gameMediaItems.ownerUserId, ownerUserId), isNull(gameMediaItems.deletedAt), isNull(games.deletedAt)];
  if (query.gameId) conditions.push(eq(gameMediaItems.gameId, query.gameId));
  if (query.source) conditions.push(eq(gameMediaItems.source, query.source));
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(or(
      ilike(games.nameZh, pattern),
      ilike(games.nameEn, pattern),
      ilike(gameMediaItems.title, pattern)
    )!);
  }
  const where = and(...conditions);
  const [items, [{ total }]] = await Promise.all([
    db.select({
      id: gameMediaItems.id,
      gameId: gameMediaItems.gameId,
      gameName: games.nameZh,
      gameNameEn: games.nameEn,
      gameCoverUrl: games.coverUrl,
      source: gameMediaItems.source,
      sourceUrl: gameMediaItems.sourceUrl,
      title: gameMediaItems.title,
      capturedAt: gameMediaItems.capturedAt,
      width: gameMediaItems.width,
      height: gameMediaItems.height,
      createdAt: gameMediaItems.createdAt,
      byteSize: fileBlobs.byteSize
    }).from(gameMediaItems)
      .innerJoin(games, eq(games.id, gameMediaItems.gameId))
      .innerJoin(fileBlobs, eq(fileBlobs.id, gameMediaItems.originalBlobId))
      .where(where)
      .orderBy(desc(sql`coalesce(${gameMediaItems.capturedAt}, ${gameMediaItems.createdAt})`), desc(gameMediaItems.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(gameMediaItems)
      .innerJoin(games, eq(games.id, gameMediaItems.gameId))
      .where(where)
  ]);

  const [statsRow] = await db.select({
    total: count(),
    gameCount: countDistinct(gameMediaItems.gameId),
    totalBytes: sum(fileBlobs.byteSize),
    steamCount: sql<number>`count(*) filter (where ${gameMediaItems.source} = 'STEAM')`,
    manualCount: sql<number>`count(*) filter (where ${gameMediaItems.source} = 'MANUAL')`
  }).from(gameMediaItems)
    .innerJoin(fileBlobs, eq(fileBlobs.id, gameMediaItems.originalBlobId))
    .where(and(eq(gameMediaItems.ownerUserId, ownerUserId), isNull(gameMediaItems.deletedAt)));

  const albumRows = await db.select({
    mediaId: gameMediaItems.id,
    gameId: gameMediaItems.gameId,
    gameName: games.nameZh,
    gameNameEn: games.nameEn,
    gameCoverUrl: games.coverUrl,
    capturedAt: gameMediaItems.capturedAt,
    createdAt: gameMediaItems.createdAt
  }).from(gameMediaItems)
    .innerJoin(games, eq(games.id, gameMediaItems.gameId))
    .where(and(eq(gameMediaItems.ownerUserId, ownerUserId), isNull(gameMediaItems.deletedAt), isNull(games.deletedAt)))
    .orderBy(desc(sql`coalesce(${gameMediaItems.capturedAt}, ${gameMediaItems.createdAt})`));
  const albums = Array.from(albumRows.reduce((map, row) => {
    const current = map.get(row.gameId);
    if (current) current.count += 1;
    else map.set(row.gameId, { ...row, count: 1 });
    return map;
  }, new Map<string, (typeof albumRows)[number] & { count: number }>()).values())
    .sort((left, right) => right.count - left.count || left.gameName.localeCompare(right.gameName, "zh-CN"));

  const gameOptions = await db.select({
    id: games.id,
    nameZh: games.nameZh,
    nameEn: games.nameEn,
    coverUrl: games.coverUrl
  }).from(games)
    .where(and(eq(games.ownerUserId, ownerUserId), isNull(games.deletedAt)))
    .orderBy(asc(games.nameZh));

  return {
    query,
    items,
    total,
    stats: {
      total: Number(statsRow?.total ?? 0),
      gameCount: Number(statsRow?.gameCount ?? 0),
      totalBytes: Number(statsRow?.totalBytes ?? 0),
      steamCount: Number(statsRow?.steamCount ?? 0),
      manualCount: Number(statsRow?.manualCount ?? 0)
    },
    albums,
    gameOptions
  };
}

export async function getExistingSteamMediaIds(ownerUserId: string, externalIds: string[]) {
  if (!externalIds.length) return new Set<string>();
  const rows = await db.select({ externalMediaId: gameMediaItems.externalMediaId }).from(gameMediaItems).where(and(
    eq(gameMediaItems.ownerUserId, ownerUserId),
    eq(gameMediaItems.source, "STEAM"),
    inArray(gameMediaItems.externalMediaId, externalIds)
  ));
  return new Set(rows.flatMap((row) => row.externalMediaId ? [row.externalMediaId] : []));
}

export async function getMediaContent(ownerUserId: string, mediaId: string, variant: "original" | "thumbnail") {
  const [media] = await db.select({
    blobId: variant === "original" ? gameMediaItems.originalBlobId : gameMediaItems.thumbnailBlobId
  }).from(gameMediaItems).where(and(
    eq(gameMediaItems.id, mediaId),
    eq(gameMediaItems.ownerUserId, ownerUserId),
    isNull(gameMediaItems.deletedAt)
  )).limit(1);
  if (!media) throw new MediaStorageError("MEDIA_NOT_FOUND", "图片不存在", 404);
  const [blob] = await db.select().from(fileBlobs).where(eq(fileBlobs.id, media.blobId)).limit(1);
  if (!blob?.storagePath || blob.status !== "READY") throw new MediaStorageError("MEDIA_FILE_MISSING", "图片文件不可用", 404);
  return { bytes: await readStoredContent(blob.storagePath), mimeType: blob.mimeType, byteSize: blob.byteSize };
}

export async function removeMedia(ownerUserId: string, mediaId: string, requestId: string) {
  return db.transaction(async (tx) => {
    const [media] = await tx.select({ id: gameMediaItems.id }).from(gameMediaItems).where(and(
      eq(gameMediaItems.id, mediaId),
      eq(gameMediaItems.ownerUserId, ownerUserId),
      isNull(gameMediaItems.deletedAt)
    )).limit(1);
    if (!media) throw new MediaStorageError("MEDIA_NOT_FOUND", "图片不存在", 404);
    await tx.update(gameMediaItems).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(gameMediaItems.id, mediaId));
    await tx.insert(auditLogs).values({
      actorUserId: ownerUserId,
      action: "media.remove",
      entityType: "game_media",
      entityId: mediaId,
      outcome: "SUCCESS",
      requestId,
      metadata: { recoverable: true }
    });
    return { id: mediaId, removed: true };
  });
}
