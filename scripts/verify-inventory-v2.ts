import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../src/server/db";

type CountRow = Record<string, number | string | null>;

async function rows(query: ReturnType<typeof sql>) {
  return (await db.execute(query)).rows as CountRow[];
}

async function main() {
  const [legacy] = await rows(sql`
    SELECT
      count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_variants,
      count(DISTINCT (owner_user_id, product_name)) FILTER (WHERE deleted_at IS NULL)::int AS active_products,
      coalesce(sum(unopened_quantity) FILTER (WHERE deleted_at IS NULL), 0)::int AS unopened,
      coalesce(sum(opened_quantity) FILTER (WHERE deleted_at IS NULL), 0)::int AS in_use
    FROM inventory_items
  `);
  const [legacyGroups] = await rows(sql`
    SELECT count(*)::int AS multi_color_products FROM (
      SELECT owner_user_id, product_name FROM inventory_items WHERE deleted_at IS NULL
      GROUP BY owner_user_id, product_name HAVING count(*) > 1
    ) grouped
  `);
  const [legacyMovements] = await rows(sql`
    SELECT count(*)::int AS movements,
      coalesce(sum(greatest(-unopened_delta, 0)) FILTER (WHERE movement_type::text = 'DISCARDED'), 0)::int AS scrapped
    FROM inventory_movements
  `);
  const [migrated] = await rows(sql`
    SELECT
      count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_variants,
      count(DISTINCT product_id) FILTER (WHERE deleted_at IS NULL)::int AS active_products,
      coalesce(sum(unopened_quantity) FILTER (WHERE deleted_at IS NULL), 0)::int AS unopened,
      coalesce(sum(in_use_quantity) FILTER (WHERE deleted_at IS NULL), 0)::int AS in_use
    FROM inventory_variants WHERE legacy_item_id IS NOT NULL
  `);
  const [migratedGroups] = await rows(sql`
    SELECT count(*)::int AS multi_color_products FROM (
      SELECT product_id FROM inventory_variants
      WHERE deleted_at IS NULL AND legacy_item_id IS NOT NULL
      GROUP BY product_id HAVING count(*) > 1
    ) grouped
  `);
  const [migratedMovements] = await rows(sql`
    SELECT count(*)::int AS movements, coalesce(sum(scrapped_delta), 0)::int AS scrapped
    FROM inventory_variant_movements WHERE legacy_movement_id IS NOT NULL
  `);
  const [allV2] = await rows(sql`
    SELECT
      count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS products,
      count(v.id) FILTER (WHERE v.deleted_at IS NULL)::int AS variants,
      coalesce(sum(v.unopened_quantity) FILTER (WHERE v.deleted_at IS NULL), 0)::int AS unopened,
      coalesce(sum(v.in_use_quantity) FILTER (WHERE v.deleted_at IS NULL), 0)::int AS in_use
    FROM inventory_products p LEFT JOIN inventory_variants v ON v.product_id = p.id
  `);
  const [allMovements] = await rows(sql`
    SELECT count(*)::int AS movements, coalesce(sum(scrapped_delta), 0)::int AS scrapped
    FROM inventory_variant_movements
  `);
  const [integrity] = await rows(sql`
    WITH movement_totals AS (
      SELECT variant_id, sum(unopened_delta)::int AS unopened, sum(in_use_delta)::int AS in_use
      FROM inventory_variant_movements GROUP BY variant_id
    )
    SELECT
      count(*) FILTER (WHERE p.id IS NULL)::int AS orphan_variants,
      count(*) FILTER (WHERE v.unopened_quantity <> coalesce(m.unopened, 0)
        OR v.in_use_quantity <> coalesce(m.in_use, 0))::int AS quantity_mismatches,
      count(*) FILTER (WHERE v.owner_user_id <> p.owner_user_id)::int AS owner_mismatches
    FROM inventory_variants v
    LEFT JOIN inventory_products p ON p.id = v.product_id
    LEFT JOIN movement_totals m ON m.variant_id = v.id
  `);
  const [legacyMapping] = await rows(sql`
    SELECT
      count(*) FILTER (WHERE v.id IS NULL)::int AS missing_variants,
      count(*) FILTER (WHERE v.product_id IS NULL OR p.id IS NULL)::int AS missing_products,
      count(*) FILTER (WHERE v.color IS DISTINCT FROM i.color
        OR v.unopened_quantity IS DISTINCT FROM i.unopened_quantity
        OR v.in_use_quantity IS DISTINCT FROM i.opened_quantity)::int AS field_mismatches
    FROM inventory_items i
    LEFT JOIN inventory_variants v ON v.legacy_item_id = i.id
    LEFT JOIN inventory_products p ON p.id = v.product_id
  `);
  const [movementMapping] = await rows(sql`
    SELECT count(*) FILTER (WHERE vm.id IS NULL)::int AS missing_movements
    FROM inventory_movements m LEFT JOIN inventory_variant_movements vm ON vm.legacy_movement_id = m.id
  `);

  const exactPairs = [
    ["activeProducts", legacy.active_products, migrated.active_products],
    ["activeVariants", legacy.active_variants, migrated.active_variants],
    ["multiColorProducts", legacyGroups.multi_color_products, migratedGroups.multi_color_products],
    ["unopened", legacy.unopened, migrated.unopened],
    ["inUse", legacy.in_use, migrated.in_use],
    ["legacyMovements", legacyMovements.movements, migratedMovements.movements],
    ["legacyScrapped", legacyMovements.scrapped, migratedMovements.scrapped]
  ] as const;
  const failures = exactPairs.filter(([, before, after]) => Number(before) !== Number(after))
    .map(([name, before, after]) => `${name}:${before}!=${after}`);
  for (const [name, value] of Object.entries({ ...integrity, ...legacyMapping, ...movementMapping })) {
    if (Number(value) !== 0) failures.push(`${name}:${value}`);
  }

  const report = {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    legacy: { ...legacy, ...legacyGroups, ...legacyMovements },
    migratedLegacy: { ...migrated, ...migratedGroups, ...migratedMovements },
    currentV2: { ...allV2, ...allMovements },
    integrity: { ...integrity, ...legacyMapping, ...movementMapping },
    failures
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeDatabase);
