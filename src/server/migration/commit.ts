import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  assets,
  games,
  gameStatusAssignments,
  importBatches,
  importRows,
  inventoryItems,
  inventoryMovements
} from "@/server/db/schema";

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
const gamePayload = z.object({
  nameZh: z.string().min(1).max(200),
  nameEn: nullableText,
  notes: nullableText,
  platformSource: nullableText,
  platform: nullableText,
  mediaType: nullableText,
  ownershipStatus: nullableText,
  handheldBest: z.boolean().nullable(),
  proEnhanced: z.boolean().nullable(),
  controllerFeatures: nullableText,
  modRequired: z.boolean(),
  priorityLevel: z.number().int().min(0).max(5).nullable(),
  priorityRank: z.enum(["A", "B"]).nullable(),
  repeatable: z.boolean(),
  releaseDate: nullableText,
  playStatus: z.enum(["BACKLOG", "PLAYING", "PAUSED", "COMPLETED", "ABANDONED", "UNPLANNED"]).nullable(),
  startedAt: nullableText,
  completedAt: nullableText,
  acquisitionNotes: nullableText
});

const assetPayload = z.object({
  categoryLarge: nullableText,
  categorySmall: nullableText,
  assetLevel: z.enum(["PARENT", "CHILD"]),
  assetName: z.string().min(1).max(300),
  parentName: nullableText,
  purchasedAt: nullableText,
  purchaseChannel: nullableText,
  purchasePrice: nullableNumber,
  saleIncome: nullableNumber,
  status: z.enum(["ACTIVE", "SOLD", "DISCARDED"]),
  notes: nullableText
});

const inventoryPayload = z.object({
  productName: z.string().min(1).max(300),
  priorityCode: nullableText,
  brand: nullableText,
  style: nullableText,
  denier: nullableText,
  colorSource: z.string().min(1),
  color: z.string().min(1),
  material: nullableText,
  composition: nullableText,
  unitPrice: nullableNumber,
  purchased: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  unopenedQuantity: z.number().int().nonnegative(),
  openedQuantity: z.number().int().nonnegative(),
  notes: nullableText,
  repurchaseSource: nullableText,
  repurchaseDecision: nullableText,
  currentLocation: nullableText
});

export type CommitResult = {
  reused: boolean;
  batchId: string;
  games: number;
  assets: number;
  inventoryItems: number;
  inventoryMovements: number;
};

export async function commitMigrationBatch(
  batchId: string,
  actorUserId: string,
  requestId: string = randomUUID()
): Promise<CommitResult> {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM import_batches WHERE id = ${batchId} FOR UPDATE`);
    const batch = (await transaction.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1))[0];
    if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
    if (batch.status === "COMMITTED") {
      // A PostgreSQL transaction owns one client connection. Keep these reads
      // sequential so repeated commit requests do not issue concurrent queries
      // on the same client (unsupported by pg and removed in pg 9).
      const gameCount = await transaction.select({ value: sql<number>`count(*)::int` })
        .from(games).where(eq(games.sourceBatchId, batchId));
      const assetCount = await transaction.select({ value: sql<number>`count(*)::int` })
        .from(assets).where(eq(assets.sourceBatchId, batchId));
      const inventoryCount = await transaction.select({ value: sql<number>`count(*)::int` })
        .from(inventoryItems).where(eq(inventoryItems.sourceBatchId, batchId));
      return {
        reused: true,
        batchId,
        games: gameCount[0].value,
        assets: assetCount[0].value,
        inventoryItems: inventoryCount[0].value,
        inventoryMovements: 0
      };
    }
    if (batch.status !== "VALIDATED" || batch.errorRows !== 0) throw new Error("IMPORT_BATCH_NOT_READY");
    const staged = await transaction.select().from(importRows).where(and(
      eq(importRows.batchId, batchId),
      inArray(importRows.status, ["SUCCESS", "WARNING"])
    )).orderBy(asc(importRows.sourceRow));
    const gameRows = staged.filter((row) => row.recordType === "GAME");
    const assetRows = staged.filter((row) => row.recordType === "ASSET");
    const inventoryRows = staged.filter((row) => row.recordType === "INVENTORY");
    if (gameRows.length !== 380 || assetRows.length !== 334 || inventoryRows.length !== 50) {
      throw new Error("IMPORT_RECONCILIATION_FAILED");
    }

    const insertedGames = [];
    for (const row of gameRows) {
      const payload = gamePayload.parse(row.normalizedPayload);
      const [game] = await transaction.insert(games).values({
        ownerUserId: actorUserId,
        nameZh: payload.nameZh,
        nameEn: payload.nameEn,
        notes: payload.notes,
        platform: payload.platform ?? payload.platformSource,
        platformSource: payload.platformSource,
        mediaType: payload.mediaType,
        ownershipStatus: payload.ownershipStatus,
        handheldBest: payload.handheldBest,
        proEnhanced: payload.proEnhanced,
        controllerFeatures: payload.controllerFeatures,
        modRequired: payload.modRequired,
        priorityLevel: null,
        priorityRank: null,
        repeatable: payload.repeatable,
        releaseDate: payload.releaseDate,
        releaseDateSource: "IMPORT",
        playStatus: payload.playStatus,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        acquisitionNotes: payload.acquisitionNotes,
        sourceBatchId: batchId,
        sourceRow: row.sourceRow
      }).returning({ id: games.id });
      if (payload.playStatus) {
        await transaction.insert(gameStatusAssignments).values({ gameId: game.id, status: payload.playStatus });
      }
      insertedGames.push(game);
    }

    const assetLookup = new Map<string, string>();
    let insertedAssetCount = 0;
    for (const row of assetRows) {
      const payload = assetPayload.parse(row.normalizedPayload);
      const lookupKey = [payload.categoryLarge ?? "", payload.parentName ?? payload.assetName].join("\u0000");
      const parentId = payload.assetLevel === "CHILD" ? assetLookup.get(lookupKey) ?? null : null;
      const [asset] = await transaction.insert(assets).values({
        ownerUserId: actorUserId,
        parentId,
        categoryLarge: payload.categoryLarge,
        categorySmall: payload.categorySmall,
        assetName: payload.assetName,
        parentNameSource: payload.parentName,
        purchasedAt: payload.purchasedAt,
        purchaseChannel: payload.purchaseChannel,
        purchasePrice: payload.purchasePrice === null ? null : String(payload.purchasePrice),
        saleIncome: payload.saleIncome === null ? null : String(payload.saleIncome),
        status: payload.status,
        notes: payload.notes,
        sourceBatchId: batchId,
        sourceRow: row.sourceRow
      }).returning({ id: assets.id });
      if (payload.assetLevel === "PARENT") assetLookup.set(lookupKey, asset.id);
      insertedAssetCount += 1;
    }

    let insertedMovementCount = 0;
    for (const row of inventoryRows) {
      const payload = inventoryPayload.parse(row.normalizedPayload);
      const [item] = await transaction.insert(inventoryItems).values({
        ownerUserId: actorUserId,
        productName: payload.productName,
        priorityCode: payload.priorityCode,
        brand: payload.brand,
        style: payload.style,
        denier: payload.denier,
        color: payload.color,
        colorSource: payload.colorSource,
        material: payload.material,
        composition: payload.composition,
        unitPrice: payload.unitPrice === null ? null : String(payload.unitPrice),
        unopenedQuantity: payload.unopenedQuantity,
        openedQuantity: payload.openedQuantity,
        notes: payload.notes,
        repurchaseDecision: payload.repurchaseDecision,
        repurchaseSource: payload.repurchaseSource,
        currentLocation: payload.currentLocation,
        sourceBatchId: batchId,
        sourceRow: row.sourceRow
      }).returning({ id: inventoryItems.id });
      const movements = [];
      if (payload.purchased) movements.push({ movementType: "PURCHASE" as const, unopenedDelta: payload.purchased, openedDelta: 0 });
      if (payload.opened) movements.push({ movementType: "OPENED" as const, unopenedDelta: -payload.opened, openedDelta: payload.opened });
      if (payload.discarded) movements.push({ movementType: "DISCARDED" as const, unopenedDelta: -payload.discarded, openedDelta: 0 });
      if (movements.length) {
        await transaction.insert(inventoryMovements).values(movements.map((movement) => ({
          itemId: item.id,
          ...movement,
          actorUserId,
          sourceBatchId: batchId,
          reason: "Excel 初始迁移"
        })));
        insertedMovementCount += movements.length;
      }
    }
    await transaction.update(importBatches).set({ status: "COMMITTED", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(importBatches.id, batchId));
    return {
      reused: false,
      batchId,
      games: insertedGames.length,
      assets: insertedAssetCount,
      inventoryItems: inventoryRows.length,
      inventoryMovements: insertedMovementCount
    };
  });
  await writeAudit({
    actorUserId,
    action: result.reused ? "migration.commit.reused" : "migration.commit",
    entityType: "import_batch",
    entityId: batchId,
    outcome: "SUCCESS",
    requestId,
    metadata: result
  });
  return result;
}

export async function compensateCommittedBatch(batchId: string, actorUserId: string, requestId: string = randomUUID()) {
  const compensated = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM import_batches WHERE id = ${batchId} FOR UPDATE`);
    const batch = (await transaction.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1))[0];
    if (!batch) throw new Error("IMPORT_BATCH_NOT_FOUND");
    if (batch.status !== "COMMITTED") throw new Error("IMPORT_BATCH_NOT_COMMITTED");
    const modifiedGames = await transaction.select({ id: games.id }).from(games).where(and(eq(games.sourceBatchId, batchId), sql`${games.version} > 1`)).limit(1);
    const modifiedInventory = await transaction.select({ id: inventoryItems.id }).from(inventoryItems)
      .where(and(eq(inventoryItems.sourceBatchId, batchId), sql`${inventoryItems.version} > 1`)).limit(1);
    const laterMovement = await transaction.select({ id: inventoryMovements.id }).from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .where(and(eq(inventoryItems.sourceBatchId, batchId), isNull(inventoryMovements.sourceBatchId))).limit(1);
    if (modifiedGames.length || modifiedInventory.length || laterMovement.length) throw new Error("IMPORT_COMPENSATION_CONFLICT");
    const now = new Date();
    await transaction.update(games).set({ deletedAt: now, updatedAt: now }).where(eq(games.sourceBatchId, batchId));
    await transaction.update(assets).set({ deletedAt: now, updatedAt: now }).where(eq(assets.sourceBatchId, batchId));
    await transaction.update(inventoryItems).set({ deletedAt: now, updatedAt: now }).where(eq(inventoryItems.sourceBatchId, batchId));
    await transaction.update(importBatches).set({ status: "ROLLED_BACK", updatedAt: now }).where(eq(importBatches.id, batchId));
    return { batchId, compensatedAt: now };
  });
  await writeAudit({ actorUserId, action: "migration.compensate", entityType: "import_batch", entityId: batchId, outcome: "SUCCESS", requestId });
  return compensated;
}
