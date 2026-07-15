import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import { inventoryItems, inventoryMovements } from "@/server/db/schema";
import { splitProductNameAndPurchaseUrl } from "@/lib/purchase-link";

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullablePurchaseUrl = z.string().trim().max(2048).url().refine((value) => /^https?:\/\//i.test(value), "购买链接只支持 HTTP/HTTPS").nullable();

export const inventoryQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

export const createInventoryItemSchema = z.object({
  productName: z.string().trim().min(1).max(300),
  purchaseUrl: nullablePurchaseUrl.optional(),
  color: z.string().trim().min(1).max(100),
  brand: nullableText(200).optional(),
  style: nullableText(200).optional(),
  material: nullableText(500).optional(),
  unitPrice: z.number().min(0).nullable().optional(),
  unopenedQuantity: z.number().int().min(0).default(0),
  openedQuantity: z.number().int().min(0).default(0),
  currentLocation: nullableText(500).optional(),
  notes: nullableText(3000).optional()
});

export const updateInventoryItemSchema = z.object({
  productName: z.string().trim().min(1).max(300),
  purchaseUrl: nullablePurchaseUrl.optional(),
  color: z.string().trim().min(1).max(100),
  brand: nullableText(200).optional(),
  style: nullableText(200).optional(),
  material: nullableText(500).optional(),
  unitPrice: z.number().min(0).nullable().optional(),
  currentLocation: nullableText(500).optional(),
  notes: nullableText(3000).optional(),
  version: z.number().int().positive()
});

const movementType = z.enum(["PURCHASE", "OPENED", "CONSUMED", "DISCARDED", "GIFTED", "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT"]);
export const inventoryMovementSchema = z.object({
  movementType,
  unopenedDelta: z.number().int(),
  openedDelta: z.number().int(),
  reason: z.string().trim().min(2).max(500),
  version: z.number().int().positive()
}).superRefine((value, context) => {
  if (value.unopenedDelta === 0 && value.openedDelta === 0) context.addIssue({ code: "custom", path: ["unopenedDelta"], message: "库存变化不能同时为0" });
  if (value.movementType === "PURCHASE" && !(value.unopenedDelta > 0 && value.openedDelta === 0)) context.addIssue({ code: "custom", message: "采购只能增加未拆封库存" });
  if (value.movementType === "OPENED" && !(value.unopenedDelta < 0 && value.openedDelta === -value.unopenedDelta)) context.addIssue({ code: "custom", message: "拆封必须等量转移到已拆封库存" });
  if (value.movementType === "CONSUMED" && !(value.unopenedDelta === 0 && value.openedDelta < 0)) context.addIssue({ code: "custom", message: "消耗只能减少已拆封库存" });
});

function escapedLike(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function listInventory(ownerUserId: string, input: z.infer<typeof inventoryQuerySchema>) {
  const conditions = [eq(inventoryItems.ownerUserId, ownerUserId), isNull(inventoryItems.deletedAt)];
  if (input.q) {
    const pattern = escapedLike(input.q);
    conditions.push(sql`(
      ${inventoryItems.productName} ILIKE ${pattern} ESCAPE '\\'
      OR ${inventoryItems.purchaseUrl} ILIKE ${pattern} ESCAPE '\\'
      OR ${inventoryItems.brand} ILIKE ${pattern} ESCAPE '\\'
      OR ${inventoryItems.color} ILIKE ${pattern} ESCAPE '\\'
      OR ${inventoryItems.currentLocation} ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  const where = and(...conditions);
  const [items, [total]] = await Promise.all([
    db.select().from(inventoryItems).where(where).orderBy(asc(inventoryItems.productName), asc(inventoryItems.color)).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(inventoryItems).where(where)
  ]);
  return { items, total: total.value, page: input.page, pageSize: input.pageSize };
}

export async function createInventoryItem(ownerUserId: string, input: z.infer<typeof createInventoryItemSchema>, requestId: string = randomUUID()) {
  const normalized = splitProductNameAndPurchaseUrl(input.productName, input.purchaseUrl);
  const record = await db.transaction(async (transaction) => {
    const [item] = await transaction.insert(inventoryItems).values({
      ownerUserId,
      productName: normalized.productName,
      purchaseUrl: normalized.purchaseUrl,
      color: input.color,
      colorSource: input.color,
      brand: input.brand ?? null,
      style: input.style ?? null,
      material: input.material ?? null,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      unopenedQuantity: input.unopenedQuantity,
      openedQuantity: input.openedQuantity,
      currentLocation: input.currentLocation ?? null,
      notes: input.notes ?? null
    }).returning();
    if (input.unopenedQuantity || input.openedQuantity) {
      await transaction.insert(inventoryMovements).values({
        itemId: item.id,
        movementType: "ADJUSTMENT",
        unopenedDelta: input.unopenedQuantity,
        openedDelta: input.openedQuantity,
        reason: "创建库存初始值",
        actorUserId: ownerUserId
      });
    }
    return item;
  });
  await writeAudit({ actorUserId: ownerUserId, action: "inventory.create", entityType: "inventory_item", entityId: record.id, outcome: "SUCCESS", requestId });
  return record;
}

export async function updateInventoryItem(ownerUserId: string, itemId: string, input: z.infer<typeof updateInventoryItemSchema>, requestId: string = randomUUID()) {
  const normalized = splitProductNameAndPurchaseUrl(input.productName, input.purchaseUrl);
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_items WHERE id = ${itemId} FOR UPDATE`);
    const current = (await transaction.select().from(inventoryItems).where(and(
      eq(inventoryItems.id, itemId),
      eq(inventoryItems.ownerUserId, ownerUserId),
      isNull(inventoryItems.deletedAt)
    )).limit(1))[0];
    if (!current) return null;
    if (current.version !== input.version) return { conflict: true as const, current };
    const [item] = await transaction.update(inventoryItems).set({
      productName: normalized.productName,
      purchaseUrl: normalized.purchaseUrl,
      color: input.color,
      colorSource: input.color,
      brand: input.brand ?? null,
      style: input.style ?? null,
      material: input.material ?? null,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      currentLocation: input.currentLocation ?? null,
      notes: input.notes ?? null,
      version: sql`${inventoryItems.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryItems.id, itemId)).returning();
    if (!item) throw new Error("INVENTORY_UPDATE_FAILED");
    return { conflict: false as const, item };
  });
  if (result && "item" in result) {
    await writeAudit({ actorUserId: ownerUserId, action: "inventory.update", entityType: "inventory_item", entityId: itemId, outcome: "SUCCESS", requestId, metadata: { purchaseUrlChanged: true } });
  }
  return result;
}

export async function addInventoryMovement(ownerUserId: string, itemId: string, input: z.infer<typeof inventoryMovementSchema>, requestId: string = randomUUID()) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_items WHERE id = ${itemId} FOR UPDATE`);
    const item = (await transaction.select().from(inventoryItems).where(and(
      eq(inventoryItems.id, itemId),
      eq(inventoryItems.ownerUserId, ownerUserId),
      isNull(inventoryItems.deletedAt)
    )).limit(1))[0];
    if (!item) return null;
    if (item.version !== input.version) return { conflict: true as const, current: item };
    const unopened = item.unopenedQuantity + input.unopenedDelta;
    const opened = item.openedQuantity + input.openedDelta;
    if (unopened < 0 || opened < 0) return { negative: true as const, current: item };
    const [movement] = await transaction.insert(inventoryMovements).values({
      itemId,
      movementType: input.movementType,
      unopenedDelta: input.unopenedDelta,
      openedDelta: input.openedDelta,
      reason: input.reason,
      actorUserId: ownerUserId
    }).returning();
    const [updated] = await transaction.update(inventoryItems).set({
      unopenedQuantity: unopened,
      openedQuantity: opened,
      version: sql`${inventoryItems.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryItems.id, itemId)).returning();
    return { conflict: false as const, movement, item: updated };
  });
  if (result && "movement" in result) await writeAudit({ actorUserId: ownerUserId, action: "inventory.movement.create", entityType: "inventory_item", entityId: itemId, outcome: "SUCCESS", requestId, metadata: { movementType: input.movementType, unopenedDelta: input.unopenedDelta, openedDelta: input.openedDelta } });
  return result;
}

export async function deleteInventoryItem(ownerUserId: string, itemId: string, requestId: string = randomUUID()) {
  const [item] = await db.update(inventoryItems).set({ deletedAt: new Date(), updatedAt: new Date(), version: sql`${inventoryItems.version} + 1` })
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.ownerUserId, ownerUserId), isNull(inventoryItems.deletedAt))).returning();
  if (item) await writeAudit({ actorUserId: ownerUserId, action: "inventory.delete", entityType: "inventory_item", entityId: itemId, outcome: "SUCCESS", requestId });
  return item ?? null;
}
