CREATE TYPE "public"."migration_record_type" AS ENUM('GAME', 'ASSET', 'INVENTORY');--> statement-breakpoint
CREATE TABLE "import_image_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"sheet_name" text NOT NULL,
	"source_row" integer NOT NULL,
	"source_column" integer NOT NULL,
	"anchor_index" integer NOT NULL,
	"media_path" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"extension" text NOT NULL,
	"status" "import_row_status" DEFAULT 'SUCCESS' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_image_refs_row_positive" CHECK ("import_image_refs"."source_row" > 0),
	CONSTRAINT "import_image_refs_column_positive" CHECK ("import_image_refs"."source_column" > 0),
	CONSTRAINT "import_image_refs_anchor_nonnegative" CHECK ("import_image_refs"."anchor_index" >= 0),
	CONSTRAINT "import_image_refs_checksum_sha256" CHECK (char_length("import_image_refs"."checksum_sha256") = 64),
	CONSTRAINT "import_image_refs_size_positive" CHECK ("import_image_refs"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"expected_count" integer NOT NULL,
	"actual_count" integer NOT NULL,
	"passed" boolean NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_reconciliations_counts_nonnegative" CHECK ("import_reconciliations"."expected_count" >= 0 AND "import_reconciliations"."actual_count" >= 0),
	CONSTRAINT "import_reconciliations_metric_length" CHECK (char_length("import_reconciliations"."metric") BETWEEN 3 AND 100)
);
--> statement-breakpoint
ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_counts_nonnegative";--> statement-breakpoint
ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_counts_within_total";--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "excluded_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "image_ref_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "unique_media_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "record_type" "migration_record_type";--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "row_checksum" text;--> statement-breakpoint
UPDATE "import_rows" SET
  "record_type" = CASE
    WHEN "sheet_name" = '科技产品（非消耗品）' THEN 'ASSET'::"migration_record_type"
    WHEN "sheet_name" = '库存' THEN 'INVENTORY'::"migration_record_type"
    ELSE 'GAME'::"migration_record_type"
  END,
  "row_checksum" = md5("id"::text) || md5("batch_id"::text || ':' || "sheet_name" || ':' || "source_row"::text)
WHERE "record_type" IS NULL OR "row_checksum" IS NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ALTER COLUMN "record_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ALTER COLUMN "row_checksum" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "import_image_refs" ADD CONSTRAINT "import_image_refs_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_reconciliations" ADD CONSTRAINT "import_reconciliations_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_image_refs_anchor_key" ON "import_image_refs" USING btree ("batch_id","sheet_name","source_row","source_column","anchor_index");--> statement-breakpoint
CREATE INDEX "import_image_refs_batch_checksum_idx" ON "import_image_refs" USING btree ("batch_id","checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "import_reconciliations_batch_metric_key" ON "import_reconciliations" USING btree ("batch_id","metric");--> statement-breakpoint
CREATE INDEX "import_reconciliations_batch_passed_idx" ON "import_reconciliations" USING btree ("batch_id","passed");--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_nonnegative" CHECK (
    "import_batches"."total_rows" >= 0 AND "import_batches"."success_rows" >= 0 AND "import_batches"."warning_rows" >= 0 AND "import_batches"."error_rows" >= 0
    AND "import_batches"."excluded_rows" >= 0 AND "import_batches"."image_ref_count" >= 0 AND "import_batches"."unique_media_count" >= 0
  );--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_within_total" CHECK (
    "import_batches"."success_rows" + "import_batches"."warning_rows" + "import_batches"."error_rows" + "import_batches"."excluded_rows" <= "import_batches"."total_rows"
  );--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_checksum_sha256" CHECK (char_length("import_rows"."row_checksum") = 64);
