import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import { db } from "@/server/db";
import {
  inventoryItems,
  inventoryMovements,
  inventoryProducts,
  inventoryVariantMovements,
  inventoryVariants
} from "@/server/db/schema";

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullablePurchaseUrl = z.string().trim().max(2048).url()
  .refine((value) => /^https?:\/\//i.test(value), "购买链接只支持 HTTP/HTTPS")
  .nullable();
const idempotencyKey = z.string().trim().min(8).max(200);
export const inventoryRepurchaseDecisionSchema = z.enum([
  "UNDECIDED",
  "REPURCHASE",
  "KEEP_OBSERVING",
  "DO_NOT_REPURCHASE"
]);

export const inventoryV2QuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  filter: z.enum(["all", "in_use", "low", "multi"]).default("all")
});

export const createInventoryProductSchema = z.object({
  productName: z.string().trim().min(1).max(300),
  brand: nullableText(200).optional(),
  style: nullableText(200).optional(),
  denier: nullableText(100).optional(),
  material: nullableText(500).optional(),
  composition: nullableText(500).optional(),
  purchaseUrl: nullablePurchaseUrl.optional(),
  consumptionPriority: z.number().int().min(0).max(5).optional(),
  productRating: z.number().int().min(0).max(5).optional(),
  color: z.string().trim().min(1).max(100),
  unitPrice: z.number().min(0).nullable().optional(),
  initialUnopened: z.number().int().min(1).max(9999).default(1),
  currentLocation: nullableText(500).optional(),
  notes: nullableText(3000).optional(),
  repurchaseDecision: inventoryRepurchaseDecisionSchema.optional(),
  idempotencyKey
});

export const updateInventoryProductRatingsSchema = z.object({
  consumptionPriority: z.number().int().min(0).max(5).optional(),
  productRating: z.number().int().min(0).max(5).optional(),
  version: z.number().int().positive()
}).refine(
  (value) => value.consumptionPriority !== undefined || value.productRating !== undefined,
  { message: "至少需要修改一个评级字段" }
);

export const updateInventoryVariantRepurchaseSchema = z.object({
  repurchaseDecision: inventoryRepurchaseDecisionSchema,
  version: z.number().int().positive()
});

export const createInventoryVariantSchema = z.object({
  color: z.string().trim().min(1).max(100),
  unitPrice: z.number().min(0).nullable().optional(),
  initialUnopened: z.number().int().min(1).max(9999).default(1),
  currentLocation: nullableText(500).optional(),
  purchaseUrlOverride: nullablePurchaseUrl.optional(),
  notes: nullableText(3000).optional(),
  repurchaseDecision: inventoryRepurchaseDecisionSchema.optional(),
  productVersion: z.number().int().positive(),
  idempotencyKey
});

export const inventoryActionSchema = z.object({
  action: z.enum(["STOCK_IN", "OPEN_FOR_USE", "SCRAP_IN_USE"]),
  quantity: z.number().int().min(1).max(9999).default(1),
  reason: z.string().trim().min(1).max(500).nullable().optional(),
  version: z.number().int().positive(),
  idempotencyKey
});

export const reverseInventoryMovementSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).default("撤销错误操作"),
  idempotencyKey
});

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function normalizeSearch(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN");
}

async function variantsForOwner(ownerUserId: string) {
  const [variantRows, scrappedRows] = await Promise.all([
    db.select().from(inventoryVariants).where(and(
      eq(inventoryVariants.ownerUserId, ownerUserId),
      isNull(inventoryVariants.deletedAt)
    )).orderBy(asc(inventoryVariants.color)),
    db.select({
      variantId: inventoryVariantMovements.variantId,
      scrappedQuantity: sql<number>`coalesce(sum(${inventoryVariantMovements.scrappedDelta}), 0)::int`
    }).from(inventoryVariantMovements)
      .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
      .where(eq(inventoryVariants.ownerUserId, ownerUserId))
      .groupBy(inventoryVariantMovements.variantId)
  ]);
  const scrappedByVariant = new Map(scrappedRows.map((row) => [row.variantId, row.scrappedQuantity]));
  return variantRows.map((variant) => ({
    ...variant,
    scrappedQuantity: scrappedByVariant.get(variant.id) ?? 0
  }));
}

export async function listInventoryProducts(ownerUserId: string, input: z.infer<typeof inventoryV2QuerySchema>) {
  const [productRows, variantRows] = await Promise.all([
    db.select().from(inventoryProducts).where(and(
      eq(inventoryProducts.ownerUserId, ownerUserId),
      isNull(inventoryProducts.deletedAt)
    )).orderBy(
      desc(inventoryProducts.consumptionPriority),
      asc(inventoryProducts.productName)
    ),
    variantsForOwner(ownerUserId)
  ]);

  const byProduct = new Map<string, typeof variantRows>();
  for (const variant of variantRows) {
    const current = byProduct.get(variant.productId) ?? [];
    current.push(variant);
    byProduct.set(variant.productId, current);
  }

  const allProducts = productRows.map((product) => ({
    ...product,
    variants: byProduct.get(product.id) ?? []
  }));
  const overview = allProducts.reduce((totals, product) => {
    totals.products += 1;
    totals.variants += product.variants.length;
    if (product.variants.length > 0 && product.variants.every((variant) => variant.repurchaseDecision === "DO_NOT_REPURCHASE")) {
      totals.retiredProducts += 1;
    }
    for (const variant of product.variants) {
      totals.unopened += variant.unopenedQuantity;
      totals.inUse += variant.inUseQuantity;
      totals.scrapped += variant.scrappedQuantity;
    }
    return totals;
  }, { products: 0, variants: 0, unopened: 0, inUse: 0, scrapped: 0, retiredProducts: 0 });

  const query = normalizeSearch(input.q);
  const products = allProducts.filter((product) => {
    const unopened = product.variants.reduce((total, variant) => total + variant.unopenedQuantity, 0);
    const inUse = product.variants.reduce((total, variant) => total + variant.inUseQuantity, 0);
    const searchable = normalizeSearch([
      product.productName,
      product.brand,
      product.style,
      product.denier,
      product.material,
      ...product.variants.flatMap((variant) => [variant.color, variant.currentLocation])
    ].filter(Boolean).join(" "));
    const matchesText = !query || searchable.includes(query);
    const matchesFilter = input.filter === "all"
      || (input.filter === "in_use" && inUse > 0)
      || (input.filter === "low" && unopened <= 1)
      || (input.filter === "multi" && product.variants.length > 1);
    return matchesText && matchesFilter;
  });

  return { products, overview, total: products.length };
}

export async function updateInventoryProductRatings(
  ownerUserId: string,
  productId: string,
  input: z.infer<typeof updateInventoryProductRatingsSchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_products WHERE id = ${productId} FOR UPDATE`);
    const product = (await transaction.select().from(inventoryProducts).where(and(
      eq(inventoryProducts.id, productId),
      eq(inventoryProducts.ownerUserId, ownerUserId),
      isNull(inventoryProducts.deletedAt)
    )).limit(1))[0];
    if (!product) return { missing: true as const };
    if (product.version !== input.version) return { conflict: true as const, currentVersion: product.version };
    const changes = {
      ...(input.consumptionPriority !== undefined && input.consumptionPriority !== product.consumptionPriority
        ? { consumptionPriority: input.consumptionPriority }
        : {}),
      ...(input.productRating !== undefined && input.productRating !== product.productRating
        ? { productRating: input.productRating }
        : {})
    };
    if (Object.keys(changes).length === 0) return { unchanged: true as const, product, changes };
    const [updated] = await transaction.update(inventoryProducts).set({
      ...changes,
      version: sql`${inventoryProducts.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryProducts.id, productId)).returning();
    return { unchanged: false as const, product: updated, changes };
  });
  if ("missing" in result || "conflict" in result) return result;
  if (!result.unchanged) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "inventory_v2.product.ratings.update",
      entityType: "inventory_product",
      entityId: productId,
      outcome: "SUCCESS",
      requestId,
      metadata: result.changes
    });
  }
  return { ...result, product: await getInventoryProduct(ownerUserId, productId) };
}

export async function updateInventoryVariantRepurchase(
  ownerUserId: string,
  variantId: string,
  input: z.infer<typeof updateInventoryVariantRepurchaseSchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_variants WHERE id = ${variantId} FOR UPDATE`);
    const variant = (await transaction.select().from(inventoryVariants).where(and(
      eq(inventoryVariants.id, variantId),
      eq(inventoryVariants.ownerUserId, ownerUserId),
      isNull(inventoryVariants.deletedAt)
    )).limit(1))[0];
    if (!variant) return { missing: true as const };
    if (variant.version !== input.version) return { conflict: true as const, current: variant };
    if ((variant.repurchaseDecision ?? "UNDECIDED") === input.repurchaseDecision) {
      return { unchanged: true as const, variant };
    }
    if (!variant.legacyItemId) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");
    await transaction.execute(sql`SELECT id FROM inventory_items WHERE id = ${variant.legacyItemId} FOR UPDATE`);
    const legacyItem = (await transaction.select().from(inventoryItems)
      .where(eq(inventoryItems.id, variant.legacyItemId)).limit(1))[0];
    if (!legacyItem) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");

    const [updated] = await transaction.update(inventoryVariants).set({
      repurchaseDecision: input.repurchaseDecision,
      version: sql`${inventoryVariants.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryVariants.id, variantId)).returning();
    await transaction.update(inventoryItems).set({
      repurchaseDecision: input.repurchaseDecision,
      version: sql`${inventoryItems.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryItems.id, legacyItem.id));
    await transaction.update(inventoryProducts).set({
      updatedAt: new Date()
    }).where(eq(inventoryProducts.id, variant.productId));
    return { unchanged: false as const, variant: updated };
  });
  if ("missing" in result || "conflict" in result) return result;
  if (!result.unchanged) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "inventory_v2.variant.repurchase.update",
      entityType: "inventory_variant",
      entityId: variantId,
      outcome: "SUCCESS",
      requestId,
      metadata: { repurchaseDecision: input.repurchaseDecision }
    });
  }
  return result;
}

export async function getInventoryProduct(ownerUserId: string, productId: string) {
  const product = (await db.select().from(inventoryProducts).where(and(
    eq(inventoryProducts.id, productId),
    eq(inventoryProducts.ownerUserId, ownerUserId),
    isNull(inventoryProducts.deletedAt)
  )).limit(1))[0];
  if (!product) return null;
  const variants = (await variantsForOwner(ownerUserId)).filter((variant) => variant.productId === productId);
  return { ...product, variants };
}

async function existingMovement(ownerUserId: string, key: string) {
  const row = (await db.select({
    movement: inventoryVariantMovements,
    variant: inventoryVariants
  }).from(inventoryVariantMovements)
    .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
    .where(and(
      eq(inventoryVariantMovements.idempotencyKey, key),
      eq(inventoryVariants.ownerUserId, ownerUserId)
    )).limit(1))[0];
  return row ?? null;
}

export async function createInventoryProduct(
  ownerUserId: string,
  input: z.infer<typeof createInventoryProductSchema>,
  requestId: string = randomUUID()
) {
  const execute = async () => db.transaction(async (transaction) => {
    const reused = await transaction.select({
      movement: inventoryVariantMovements,
      variant: inventoryVariants
    }).from(inventoryVariantMovements)
      .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
      .where(and(
        eq(inventoryVariantMovements.idempotencyKey, input.idempotencyKey),
        eq(inventoryVariants.ownerUserId, ownerUserId)
      )).limit(1);
    if (reused[0]) return { reused: true as const, ...reused[0] };

    const [product] = await transaction.insert(inventoryProducts).values({
      ownerUserId,
      productName: input.productName,
      brand: input.brand ?? null,
      style: input.style ?? null,
      denier: input.denier ?? null,
      material: input.material ?? null,
      composition: input.composition ?? null,
      purchaseUrl: input.purchaseUrl ?? null,
      consumptionPriority: input.consumptionPriority ?? 0,
      productRating: input.productRating ?? 0
    }).returning();
    const [legacyItem] = await transaction.insert(inventoryItems).values({
      ownerUserId,
      productName: input.productName,
      purchaseUrl: input.purchaseUrl ?? null,
      color: input.color,
      colorSource: input.color,
      brand: input.brand ?? null,
      style: input.style ?? null,
      denier: input.denier ?? null,
      material: input.material ?? null,
      composition: input.composition ?? null,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      unopenedQuantity: input.initialUnopened,
      openedQuantity: 0,
      currentLocation: input.currentLocation ?? null,
      notes: input.notes ?? null,
      repurchaseDecision: input.repurchaseDecision ?? null
    }).returning();
    const [variant] = await transaction.insert(inventoryVariants).values({
      id: legacyItem.id,
      productId: product.id,
      ownerUserId,
      legacyItemId: legacyItem.id,
      color: input.color,
      colorSource: input.color,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      unopenedQuantity: input.initialUnopened,
      inUseQuantity: 0,
      currentLocation: input.currentLocation ?? null,
      notes: input.notes ?? null,
      repurchaseDecision: input.repurchaseDecision ?? null
    }).returning();
    const [legacyMovement] = await transaction.insert(inventoryMovements).values({
      itemId: legacyItem.id,
      movementType: "PURCHASE",
      unopenedDelta: input.initialUnopened,
      openedDelta: 0,
      reason: "V0.22 创建货品并完成初始入库",
      actorUserId: ownerUserId
    }).returning();
    const [movement] = await transaction.insert(inventoryVariantMovements).values({
      id: legacyMovement.id,
      variantId: variant.id,
      legacyMovementId: legacyMovement.id,
      movementType: "STOCK_IN",
      unopenedDelta: input.initialUnopened,
      inUseDelta: 0,
      scrappedDelta: 0,
      reason: "创建货品并完成初始入库",
      actorUserId: ownerUserId,
      idempotencyKey: input.idempotencyKey
    }).returning();
    return { reused: false as const, product, variant, movement };
  });

  let result;
  try {
    result = await execute();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const reused = await existingMovement(ownerUserId, input.idempotencyKey);
    if (!reused) throw error;
    result = { reused: true as const, ...reused };
  }
  if (!result.reused) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "inventory_v2.product.create",
      entityType: "inventory_product",
      entityId: result.product.id,
      outcome: "SUCCESS",
      requestId,
      metadata: { variantId: result.variant.id, initialUnopened: input.initialUnopened }
    });
  }
  const productId = result.reused ? result.variant.productId : result.product.id;
  return { reused: result.reused, product: await getInventoryProduct(ownerUserId, productId), movement: result.movement };
}

export async function addInventoryVariant(
  ownerUserId: string,
  productId: string,
  input: z.infer<typeof createInventoryVariantSchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_products WHERE id = ${productId} FOR UPDATE`);
    const product = (await transaction.select().from(inventoryProducts).where(and(
      eq(inventoryProducts.id, productId),
      eq(inventoryProducts.ownerUserId, ownerUserId),
      isNull(inventoryProducts.deletedAt)
    )).limit(1))[0];
    if (!product) return { missing: true as const };

    const reused = (await transaction.select({
      movement: inventoryVariantMovements,
      variant: inventoryVariants
    }).from(inventoryVariantMovements)
      .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
      .where(and(
        eq(inventoryVariantMovements.idempotencyKey, input.idempotencyKey),
        eq(inventoryVariants.ownerUserId, ownerUserId)
      )).limit(1))[0];
    if (reused) return { reused: true as const, ...reused };
    if (product.version !== input.productVersion) return { conflict: true as const, currentVersion: product.version };

    const [variant] = await transaction.insert(inventoryVariants).values({
      id: randomUUID(),
      productId,
      ownerUserId,
      color: input.color,
      colorSource: input.color,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      unopenedQuantity: input.initialUnopened,
      inUseQuantity: 0,
      currentLocation: input.currentLocation ?? null,
      purchaseUrlOverride: input.purchaseUrlOverride ?? null,
      notes: input.notes ?? null,
      repurchaseDecision: input.repurchaseDecision ?? null
    }).returning();
    const [legacyItem] = await transaction.insert(inventoryItems).values({
      id: variant.id,
      ownerUserId,
      productName: product.productName,
      purchaseUrl: input.purchaseUrlOverride ?? product.purchaseUrl,
      color: input.color,
      colorSource: input.color,
      brand: product.brand,
      style: product.style,
      denier: product.denier,
      material: product.material,
      composition: product.composition,
      unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : String(input.unitPrice),
      unopenedQuantity: input.initialUnopened,
      openedQuantity: 0,
      currentLocation: input.currentLocation ?? null,
      notes: input.notes ?? null,
      repurchaseDecision: input.repurchaseDecision ?? null
    }).returning();
    await transaction.update(inventoryVariants).set({ legacyItemId: legacyItem.id }).where(eq(inventoryVariants.id, variant.id));
    const [legacyMovement] = await transaction.insert(inventoryMovements).values({
      itemId: legacyItem.id,
      movementType: "PURCHASE",
      unopenedDelta: input.initialUnopened,
      openedDelta: 0,
      reason: "V0.22 新增颜色并完成初始入库",
      actorUserId: ownerUserId
    }).returning();
    const [movement] = await transaction.insert(inventoryVariantMovements).values({
      id: legacyMovement.id,
      variantId: variant.id,
      legacyMovementId: legacyMovement.id,
      movementType: "STOCK_IN",
      unopenedDelta: input.initialUnopened,
      inUseDelta: 0,
      scrappedDelta: 0,
      reason: "新增颜色并完成初始入库",
      actorUserId: ownerUserId,
      idempotencyKey: input.idempotencyKey
    }).returning();
    await transaction.update(inventoryProducts).set({
      version: sql`${inventoryProducts.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryProducts.id, productId));
    return { reused: false as const, variant, movement };
  });
  if ("missing" in result || "conflict" in result) return result;
  if (!result.reused) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "inventory_v2.variant.create",
      entityType: "inventory_product",
      entityId: productId,
      outcome: "SUCCESS",
      requestId,
      metadata: { variantId: result.variant.id, initialUnopened: input.initialUnopened }
    });
  }
  return { reused: result.reused, product: await getInventoryProduct(ownerUserId, productId), movement: result.movement };
}

const actionDeltas = {
  STOCK_IN: (quantity: number) => ({ unopenedDelta: quantity, inUseDelta: 0, scrappedDelta: 0, reason: "已有颜色入库", legacyType: "PURCHASE" as const }),
  OPEN_FOR_USE: (quantity: number) => ({ unopenedDelta: -quantity, inUseDelta: quantity, scrappedDelta: 0, reason: "拆封投入使用", legacyType: "OPENED" as const }),
  SCRAP_IN_USE: (quantity: number) => ({ unopenedDelta: 0, inUseDelta: -quantity, scrappedDelta: quantity, reason: "使用中货品报废", legacyType: "CONSUMED" as const })
} as const;

export async function applyInventoryAction(
  ownerUserId: string,
  variantId: string,
  input: z.infer<typeof inventoryActionSchema>,
  requestId: string = randomUUID()
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_variants WHERE id = ${variantId} FOR UPDATE`);
    const variant = (await transaction.select().from(inventoryVariants).where(and(
      eq(inventoryVariants.id, variantId),
      eq(inventoryVariants.ownerUserId, ownerUserId),
      isNull(inventoryVariants.deletedAt)
    )).limit(1))[0];
    if (!variant) return { missing: true as const };
    const reused = (await transaction.select().from(inventoryVariantMovements)
      .where(and(
        eq(inventoryVariantMovements.idempotencyKey, input.idempotencyKey),
        eq(inventoryVariantMovements.variantId, variantId)
      )).limit(1))[0];
    if (reused) return { reused: true as const, movement: reused, variant };
    if (variant.version !== input.version) return { conflict: true as const, current: variant };

    const deltas = actionDeltas[input.action](input.quantity);
    const unopened = variant.unopenedQuantity + deltas.unopenedDelta;
    const inUse = variant.inUseQuantity + deltas.inUseDelta;
    if (unopened < 0 || inUse < 0) return { negative: true as const, current: variant };
    if (!variant.legacyItemId) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");
    await transaction.execute(sql`SELECT id FROM inventory_items WHERE id = ${variant.legacyItemId} FOR UPDATE`);
    const legacyItem = (await transaction.select().from(inventoryItems).where(eq(inventoryItems.id, variant.legacyItemId)).limit(1))[0];
    if (!legacyItem) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");
    if (legacyItem.unopenedQuantity + deltas.unopenedDelta < 0 || legacyItem.openedQuantity + deltas.inUseDelta < 0) {
      throw new Error("INVENTORY_V2_LEGACY_MIRROR_NEGATIVE");
    }
    const [legacyMovement] = await transaction.insert(inventoryMovements).values({
      itemId: legacyItem.id,
      movementType: deltas.legacyType,
      unopenedDelta: deltas.unopenedDelta,
      openedDelta: deltas.inUseDelta,
      reason: input.reason ?? `V0.22 ${deltas.reason}`,
      actorUserId: ownerUserId
    }).returning();
    const [movement] = await transaction.insert(inventoryVariantMovements).values({
      id: legacyMovement.id,
      variantId,
      legacyMovementId: legacyMovement.id,
      movementType: input.action,
      unopenedDelta: deltas.unopenedDelta,
      inUseDelta: deltas.inUseDelta,
      scrappedDelta: deltas.scrappedDelta,
      reason: input.reason ?? deltas.reason,
      actorUserId: ownerUserId,
      idempotencyKey: input.idempotencyKey
    }).returning();
    const [updated] = await transaction.update(inventoryVariants).set({
      unopenedQuantity: unopened,
      inUseQuantity: inUse,
      version: sql`${inventoryVariants.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryVariants.id, variantId)).returning();
    await transaction.update(inventoryItems).set({
      unopenedQuantity: legacyItem.unopenedQuantity + deltas.unopenedDelta,
      openedQuantity: legacyItem.openedQuantity + deltas.inUseDelta,
      version: sql`${inventoryItems.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryItems.id, legacyItem.id));
    return { reused: false as const, movement, variant: updated };
  });
  if ("missing" in result || "conflict" in result || "negative" in result) return result;
  if (!result.reused) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: `inventory_v2.${input.action.toLocaleLowerCase()}`,
      entityType: "inventory_variant",
      entityId: variantId,
      outcome: "SUCCESS",
      requestId,
      metadata: { quantity: input.quantity, movementId: result.movement.id }
    });
  }
  return result;
}

export async function reverseInventoryMovement(
  ownerUserId: string,
  movementId: string,
  input: z.infer<typeof reverseInventoryMovementSchema>,
  requestId: string = randomUUID()
) {
  const source = (await db.select({ movement: inventoryVariantMovements, variant: inventoryVariants })
    .from(inventoryVariantMovements)
    .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
    .where(and(
      eq(inventoryVariantMovements.id, movementId),
      eq(inventoryVariants.ownerUserId, ownerUserId)
    )).limit(1))[0];
  if (!source) return { missing: true as const };

  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM inventory_variants WHERE id = ${source.variant.id} FOR UPDATE`);
    const original = (await transaction.select().from(inventoryVariantMovements)
      .where(eq(inventoryVariantMovements.id, movementId)).limit(1))[0];
    const variant = (await transaction.select().from(inventoryVariants).where(and(
      eq(inventoryVariants.id, source.variant.id),
      eq(inventoryVariants.ownerUserId, ownerUserId),
      isNull(inventoryVariants.deletedAt)
    )).limit(1))[0];
    if (!original || !variant) return { missing: true as const };
    const existingReverse = (await transaction.select().from(inventoryVariantMovements)
      .where(eq(inventoryVariantMovements.reversesMovementId, movementId)).limit(1))[0];
    if (existingReverse) return { reused: true as const, movement: existingReverse, variant };
    if (!["STOCK_IN", "OPEN_FOR_USE", "SCRAP_IN_USE"].includes(original.movementType)) {
      return { notReversible: true as const };
    }
    if (variant.version !== input.version) return { conflict: true as const, current: variant };
    const unopened = variant.unopenedQuantity - original.unopenedDelta;
    const inUse = variant.inUseQuantity - original.inUseDelta;
    const [scrapped] = await transaction.select({ value: sql<number>`coalesce(sum(${inventoryVariantMovements.scrappedDelta}), 0)::int` })
      .from(inventoryVariantMovements).where(eq(inventoryVariantMovements.variantId, variant.id));
    if (unopened < 0 || inUse < 0 || scrapped.value - original.scrappedDelta < 0) return { negative: true as const, current: variant };
    if (!variant.legacyItemId) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");
    await transaction.execute(sql`SELECT id FROM inventory_items WHERE id = ${variant.legacyItemId} FOR UPDATE`);
    const legacyItem = (await transaction.select().from(inventoryItems).where(eq(inventoryItems.id, variant.legacyItemId)).limit(1))[0];
    if (!legacyItem) throw new Error("INVENTORY_V2_LEGACY_MIRROR_MISSING");
    const legacyUnopened = legacyItem.unopenedQuantity - original.unopenedDelta;
    const legacyOpened = legacyItem.openedQuantity - original.inUseDelta;
    if (legacyUnopened < 0 || legacyOpened < 0) throw new Error("INVENTORY_V2_LEGACY_MIRROR_NEGATIVE");
    const [legacyMovement] = await transaction.insert(inventoryMovements).values({
      itemId: legacyItem.id,
      movementType: "ADJUSTMENT",
      unopenedDelta: -original.unopenedDelta,
      openedDelta: -original.inUseDelta,
      reason: `V0.22 撤销：${input.reason}`,
      actorUserId: ownerUserId
    }).returning();
    const [movement] = await transaction.insert(inventoryVariantMovements).values({
      id: legacyMovement.id,
      variantId: variant.id,
      legacyMovementId: legacyMovement.id,
      movementType: "REVERSE",
      unopenedDelta: -original.unopenedDelta,
      inUseDelta: -original.inUseDelta,
      scrappedDelta: -original.scrappedDelta,
      reason: input.reason,
      actorUserId: ownerUserId,
      idempotencyKey: input.idempotencyKey,
      reversesMovementId: original.id
    }).returning();
    const [updated] = await transaction.update(inventoryVariants).set({
      unopenedQuantity: unopened,
      inUseQuantity: inUse,
      version: sql`${inventoryVariants.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryVariants.id, variant.id)).returning();
    await transaction.update(inventoryItems).set({
      unopenedQuantity: legacyUnopened,
      openedQuantity: legacyOpened,
      version: sql`${inventoryItems.version} + 1`,
      updatedAt: new Date()
    }).where(eq(inventoryItems.id, legacyItem.id));
    return { reused: false as const, movement, variant: updated };
  });
  if ("missing" in result || "conflict" in result || "negative" in result || "notReversible" in result) return result;
  if (!result.reused) {
    await writeAudit({
      actorUserId: ownerUserId,
      action: "inventory_v2.movement.reverse",
      entityType: "inventory_variant",
      entityId: result.variant.id,
      outcome: "SUCCESS",
      requestId,
      metadata: { movementId: result.movement.id, reversesMovementId: movementId }
    });
  }
  return result;
}

export async function listRecentInventoryMovements(ownerUserId: string, limit = 100) {
  return db.select({
    id: inventoryVariantMovements.id,
    movementType: inventoryVariantMovements.movementType,
    unopenedDelta: inventoryVariantMovements.unopenedDelta,
    inUseDelta: inventoryVariantMovements.inUseDelta,
    scrappedDelta: inventoryVariantMovements.scrappedDelta,
    reason: inventoryVariantMovements.reason,
    reversesMovementId: inventoryVariantMovements.reversesMovementId,
    createdAt: inventoryVariantMovements.createdAt,
    variantId: inventoryVariants.id,
    variantVersion: inventoryVariants.version,
    color: inventoryVariants.color,
    productId: inventoryProducts.id,
    productName: inventoryProducts.productName
  }).from(inventoryVariantMovements)
    .innerJoin(inventoryVariants, eq(inventoryVariantMovements.variantId, inventoryVariants.id))
    .innerJoin(inventoryProducts, eq(inventoryVariants.productId, inventoryProducts.id))
    .where(eq(inventoryVariants.ownerUserId, ownerUserId))
    .orderBy(desc(inventoryVariantMovements.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}
