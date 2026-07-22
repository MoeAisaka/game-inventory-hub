CREATE TYPE "public"."inventory_variant_movement_type" AS ENUM('STOCK_IN', 'OPEN_FOR_USE', 'SCRAP_IN_USE', 'REVERSE', 'LEGACY_PURCHASE', 'LEGACY_OPENED', 'LEGACY_CONSUMED', 'LEGACY_DISCARD_UNOPENED', 'LEGACY_GIFTED', 'LEGACY_TRANSFER_IN', 'LEGACY_TRANSFER_OUT', 'LEGACY_ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "inventory_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"brand" text,
	"style" text,
	"denier" text,
	"material" text,
	"composition" text,
	"purchase_url" text,
	"priority_code" text,
	"legacy_group_key" text,
	"deleted_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_products_name_length" CHECK (char_length("inventory_products"."product_name") BETWEEN 1 AND 300),
	CONSTRAINT "inventory_products_purchase_url" CHECK ("inventory_products"."purchase_url" IS NULL OR (char_length("inventory_products"."purchase_url") BETWEEN 8 AND 2048 AND "inventory_products"."purchase_url" ~ '^https?://')),
	CONSTRAINT "inventory_products_version_positive" CHECK ("inventory_products"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_variant_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"legacy_movement_id" uuid,
	"movement_type" "inventory_variant_movement_type" NOT NULL,
	"unopened_delta" integer DEFAULT 0 NOT NULL,
	"in_use_delta" integer DEFAULT 0 NOT NULL,
	"scrapped_delta" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"reverses_movement_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_variant_movements_nonzero" CHECK ("inventory_variant_movements"."unopened_delta" <> 0 OR "inventory_variant_movements"."in_use_delta" <> 0 OR "inventory_variant_movements"."scrapped_delta" <> 0),
	CONSTRAINT "inventory_variant_movements_scrapped_nonnegative_action" CHECK ("inventory_variant_movements"."movement_type" NOT IN ('SCRAP_IN_USE', 'LEGACY_DISCARD_UNOPENED') OR "inventory_variant_movements"."scrapped_delta" > 0),
	CONSTRAINT "inventory_variant_movements_idempotency_length" CHECK (char_length("inventory_variant_movements"."idempotency_key") BETWEEN 8 AND 200),
	CONSTRAINT "inventory_variant_movements_reason_length" CHECK (char_length("inventory_variant_movements"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "inventory_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"legacy_item_id" uuid,
	"color" text NOT NULL,
	"color_source" text,
	"unit_price" numeric(12, 2),
	"unopened_quantity" integer DEFAULT 0 NOT NULL,
	"in_use_quantity" integer DEFAULT 0 NOT NULL,
	"current_location" text,
	"purchase_url_override" text,
	"notes" text,
	"repurchase_decision" text,
	"repurchase_source" text,
	"deleted_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_variants_color_length" CHECK (char_length("inventory_variants"."color") BETWEEN 1 AND 100),
	CONSTRAINT "inventory_variants_quantity_nonnegative" CHECK ("inventory_variants"."unopened_quantity" >= 0 AND "inventory_variants"."in_use_quantity" >= 0),
	CONSTRAINT "inventory_variants_unit_price_nonnegative" CHECK ("inventory_variants"."unit_price" IS NULL OR "inventory_variants"."unit_price" >= 0),
	CONSTRAINT "inventory_variants_purchase_url_override" CHECK ("inventory_variants"."purchase_url_override" IS NULL OR (char_length("inventory_variants"."purchase_url_override") BETWEEN 8 AND 2048 AND "inventory_variants"."purchase_url_override" ~ '^https?://')),
	CONSTRAINT "inventory_variants_version_positive" CHECK ("inventory_variants"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variant_movements" ADD CONSTRAINT "inventory_variant_movements_variant_id_inventory_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."inventory_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variant_movements" ADD CONSTRAINT "inventory_variant_movements_legacy_movement_id_inventory_movements_id_fk" FOREIGN KEY ("legacy_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variant_movements" ADD CONSTRAINT "inventory_variant_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variant_movements" ADD CONSTRAINT "inventory_variant_movements_reverses_movement_id_inventory_variant_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."inventory_variant_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variants" ADD CONSTRAINT "inventory_variants_product_id_inventory_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."inventory_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variants" ADD CONSTRAINT "inventory_variants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_variants" ADD CONSTRAINT "inventory_variants_legacy_item_id_inventory_items_id_fk" FOREIGN KEY ("legacy_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_products_owner_active_name_key" ON "inventory_products" USING btree ("owner_user_id","product_name") WHERE "inventory_products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inventory_products_owner_name_idx" ON "inventory_products" USING btree ("owner_user_id","product_name");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variant_movements_legacy_key" ON "inventory_variant_movements" USING btree ("legacy_movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variant_movements_idempotency_key" ON "inventory_variant_movements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variant_movements_single_reverse_key" ON "inventory_variant_movements" USING btree ("reverses_movement_id") WHERE "inventory_variant_movements"."reverses_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_variant_movements_variant_created_idx" ON "inventory_variant_movements" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variants_legacy_item_key" ON "inventory_variants" USING btree ("legacy_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_variants_product_active_color_key" ON "inventory_variants" USING btree ("product_id","color") WHERE "inventory_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inventory_variants_owner_product_idx" ON "inventory_variants" USING btree ("owner_user_id","product_id");
--> statement-breakpoint
INSERT INTO "inventory_products" (
	"owner_user_id", "product_name", "brand", "style", "denier", "material", "composition",
	"purchase_url", "priority_code", "legacy_group_key", "deleted_at", "version", "created_at", "updated_at"
)
SELECT
	"owner_user_id",
	"product_name",
	min("brand") FILTER (WHERE "brand" IS NOT NULL),
	min("style") FILTER (WHERE "style" IS NOT NULL),
	min("denier") FILTER (WHERE "denier" IS NOT NULL),
	min("material") FILTER (WHERE "material" IS NOT NULL),
	min("composition") FILTER (WHERE "composition" IS NOT NULL),
	CASE WHEN count(DISTINCT "purchase_url") = 1 THEN min("purchase_url") FILTER (WHERE "purchase_url" IS NOT NULL) END,
	min("priority_code") FILTER (WHERE "priority_code" IS NOT NULL),
	"product_name",
	CASE WHEN count(*) FILTER (WHERE "deleted_at" IS NULL) = 0 THEN max("deleted_at") END,
	greatest(max("version"), 1),
	min("created_at"),
	max("updated_at")
FROM "inventory_items"
GROUP BY "owner_user_id", "product_name";
--> statement-breakpoint
INSERT INTO "inventory_variants" (
	"id", "product_id", "owner_user_id", "legacy_item_id", "color", "color_source", "unit_price",
	"unopened_quantity", "in_use_quantity", "current_location", "purchase_url_override", "notes",
	"repurchase_decision", "repurchase_source", "deleted_at", "version", "created_at", "updated_at"
)
SELECT
	i."id",
	p."id",
	i."owner_user_id",
	i."id",
	i."color",
	i."color_source",
	i."unit_price",
	i."unopened_quantity",
	i."opened_quantity",
	i."current_location",
	i."purchase_url",
	i."notes",
	i."repurchase_decision",
	i."repurchase_source",
	i."deleted_at",
	i."version",
	i."created_at",
	i."updated_at"
FROM "inventory_items" i
JOIN "inventory_products" p
	ON p."owner_user_id" = i."owner_user_id"
	AND p."legacy_group_key" = i."product_name";
--> statement-breakpoint
INSERT INTO "inventory_variant_movements" (
	"id", "variant_id", "legacy_movement_id", "movement_type", "unopened_delta", "in_use_delta",
	"scrapped_delta", "reason", "actor_user_id", "idempotency_key", "created_at"
)
SELECT
	m."id",
	m."item_id",
	m."id",
	CASE m."movement_type"::text
		WHEN 'PURCHASE' THEN 'LEGACY_PURCHASE'
		WHEN 'OPENED' THEN 'LEGACY_OPENED'
		WHEN 'CONSUMED' THEN 'LEGACY_CONSUMED'
		WHEN 'DISCARDED' THEN 'LEGACY_DISCARD_UNOPENED'
		WHEN 'GIFTED' THEN 'LEGACY_GIFTED'
		WHEN 'TRANSFER_IN' THEN 'LEGACY_TRANSFER_IN'
		WHEN 'TRANSFER_OUT' THEN 'LEGACY_TRANSFER_OUT'
		ELSE 'LEGACY_ADJUSTMENT'
	END::"inventory_variant_movement_type",
	m."unopened_delta",
	m."opened_delta",
	CASE WHEN m."movement_type"::text = 'DISCARDED' THEN greatest(-m."unopened_delta", 0) ELSE 0 END,
	coalesce(nullif(btrim(m."reason"), ''), '历史库存流水'),
	m."actor_user_id",
	'legacy:' || m."id"::text,
	m."created_at"
FROM "inventory_movements" m;
--> statement-breakpoint
DO $$
DECLARE
	legacy_item_count integer;
	legacy_active_item_count integer;
	legacy_product_count integer;
	legacy_active_product_count integer;
	legacy_multi_product_count integer;
	legacy_movement_count integer;
	legacy_unopened integer;
	legacy_in_use integer;
	legacy_scrapped integer;
	v2_item_count integer;
	v2_active_item_count integer;
	v2_product_count integer;
	v2_active_product_count integer;
	v2_multi_product_count integer;
	v2_movement_count integer;
	v2_unopened integer;
	v2_in_use integer;
	v2_scrapped integer;
BEGIN
	IF EXISTS (
		SELECT 1 FROM "inventory_items"
		GROUP BY "owner_user_id", "product_name"
		HAVING count(DISTINCT "brand") > 1
			OR count(DISTINCT "style") > 1
			OR count(DISTINCT "denier") > 1
			OR count(DISTINCT "material") > 1
			OR count(DISTINCT "composition") > 1
	) THEN
		RAISE EXCEPTION 'INVENTORY_V2_SHARED_FIELD_CONFLICT';
	END IF;

	SELECT count(*), count(*) FILTER (WHERE "deleted_at" IS NULL),
		coalesce(sum("unopened_quantity") FILTER (WHERE "deleted_at" IS NULL), 0),
		coalesce(sum("opened_quantity") FILTER (WHERE "deleted_at" IS NULL), 0)
	INTO legacy_item_count, legacy_active_item_count, legacy_unopened, legacy_in_use
	FROM "inventory_items";

	SELECT count(DISTINCT ("owner_user_id", "product_name")),
		count(DISTINCT ("owner_user_id", "product_name")) FILTER (WHERE "deleted_at" IS NULL)
	INTO legacy_product_count, legacy_active_product_count
	FROM "inventory_items";

	SELECT count(*) INTO legacy_multi_product_count FROM (
		SELECT "owner_user_id", "product_name"
		FROM "inventory_items"
		WHERE "deleted_at" IS NULL
		GROUP BY "owner_user_id", "product_name"
		HAVING count(*) > 1
	) grouped;

	SELECT count(*) INTO legacy_movement_count FROM "inventory_movements";
	SELECT coalesce(sum(greatest(-"unopened_delta", 0)), 0) INTO legacy_scrapped
	FROM "inventory_movements" WHERE "movement_type"::text = 'DISCARDED';

	SELECT count(*), count(*) FILTER (WHERE "deleted_at" IS NULL),
		coalesce(sum("unopened_quantity") FILTER (WHERE "deleted_at" IS NULL), 0),
		coalesce(sum("in_use_quantity") FILTER (WHERE "deleted_at" IS NULL), 0)
	INTO v2_item_count, v2_active_item_count, v2_unopened, v2_in_use
	FROM "inventory_variants" WHERE "legacy_item_id" IS NOT NULL;

	SELECT count(*), count(*) FILTER (WHERE "deleted_at" IS NULL)
	INTO v2_product_count, v2_active_product_count
	FROM "inventory_products" WHERE "legacy_group_key" IS NOT NULL;

	SELECT count(*) INTO v2_multi_product_count FROM (
		SELECT v."product_id"
		FROM "inventory_variants" v
		WHERE v."deleted_at" IS NULL AND v."legacy_item_id" IS NOT NULL
		GROUP BY v."product_id"
		HAVING count(*) > 1
	) grouped;

	SELECT count(*), coalesce(sum("scrapped_delta"), 0)
	INTO v2_movement_count, v2_scrapped
	FROM "inventory_variant_movements" WHERE "legacy_movement_id" IS NOT NULL;

	IF legacy_item_count <> v2_item_count
		OR legacy_active_item_count <> v2_active_item_count
		OR legacy_product_count <> v2_product_count
		OR legacy_active_product_count <> v2_active_product_count
		OR legacy_multi_product_count <> v2_multi_product_count
		OR legacy_movement_count <> v2_movement_count
		OR legacy_unopened <> v2_unopened
		OR legacy_in_use <> v2_in_use
		OR legacy_scrapped <> v2_scrapped THEN
		RAISE EXCEPTION 'INVENTORY_V2_RECONCILIATION_FAILED';
	END IF;
END $$;
