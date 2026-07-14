CREATE TYPE "public"."asset_status" AS ENUM('ACTIVE', 'SOLD', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."data_source" AS ENUM('MANUAL', 'IMPORT', 'STEAM', 'IGDB');--> statement-breakpoint
CREATE TYPE "public"."external_account_status" AS ENUM('ACTIVE', 'DISABLED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."external_provider" AS ENUM('STEAM', 'IGDB', 'PLAYSTATION', 'NINTENDO');--> statement-breakpoint
CREATE TYPE "public"."game_play_status" AS ENUM('BACKLOG', 'PLAYING', 'PAUSED', 'COMPLETED', 'ABANDONED', 'UNPLANNED');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('PURCHASE', 'OPENED', 'CONSUMED', 'DISCARDED', 'GIFTED', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."sync_job_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"parent_id" uuid,
	"category_large" text,
	"category_small" text,
	"asset_name" text NOT NULL,
	"parent_name_source" text,
	"purchased_at" date,
	"purchase_channel" text,
	"purchase_price" numeric(12, 2),
	"sale_income" numeric(12, 2),
	"status" "asset_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"source_batch_id" uuid,
	"source_row" integer,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_name_length" CHECK (char_length("assets"."asset_name") BETWEEN 1 AND 300),
	CONSTRAINT "assets_prices_nonnegative" CHECK (
    ("assets"."purchase_price" IS NULL OR "assets"."purchase_price" >= 0)
    AND ("assets"."sale_income" IS NULL OR "assets"."sale_income" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE "external_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"status" "external_account_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_synced_at" timestamp (3) with time zone,
	"last_error_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_accounts_user_id_length" CHECK (char_length("external_accounts"."external_user_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "external_game_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"external_game_id" text NOT NULL,
	"match_confidence" integer DEFAULT 100 NOT NULL,
	"manually_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_game_mappings_confidence_range" CHECK ("external_game_mappings"."match_confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "game_play_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"minutes" integer NOT NULL,
	"source" "data_source" DEFAULT 'MANUAL' NOT NULL,
	"notes" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_play_sessions_minutes_positive" CHECK ("game_play_sessions"."minutes" > 0),
	CONSTRAINT "game_play_sessions_date_order" CHECK ("game_play_sessions"."ended_at" IS NULL OR "game_play_sessions"."ended_at" >= "game_play_sessions"."started_at")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name_zh" text NOT NULL,
	"name_en" text,
	"notes" text,
	"platform" text,
	"platform_source" text,
	"media_type" text,
	"ownership_status" text,
	"handheld_best" boolean,
	"pro_enhanced" boolean,
	"controller_features" text,
	"mod_required" boolean DEFAULT false NOT NULL,
	"priority_level" integer,
	"priority_rank" text,
	"repeatable" boolean DEFAULT false NOT NULL,
	"release_date" date,
	"release_date_source" "data_source" DEFAULT 'IMPORT' NOT NULL,
	"play_status" "game_play_status",
	"started_at" date,
	"completed_at" date,
	"last_played_at" timestamp (3) with time zone,
	"progress_percent" integer,
	"playtime_minutes_manual" integer,
	"playtime_minutes_synced" integer DEFAULT 0 NOT NULL,
	"estimated_hastily_minutes" integer,
	"estimated_normally_minutes" integer,
	"estimated_completely_minutes" integer,
	"cover_url" text,
	"steam_app_id" integer,
	"igdb_game_id" integer,
	"igdb_last_attempt_at" timestamp (3) with time zone,
	"acquisition_notes" text,
	"source_batch_id" uuid,
	"source_row" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_name_length" CHECK (char_length("games"."name_zh") BETWEEN 1 AND 200),
	CONSTRAINT "games_priority_level_range" CHECK ("games"."priority_level" IS NULL OR "games"."priority_level" BETWEEN 0 AND 5),
	CONSTRAINT "games_priority_rank_value" CHECK ("games"."priority_rank" IS NULL OR "games"."priority_rank" IN ('A', 'B')),
	CONSTRAINT "games_progress_range" CHECK ("games"."progress_percent" IS NULL OR "games"."progress_percent" BETWEEN 0 AND 100),
	CONSTRAINT "games_playtime_nonnegative" CHECK (
    ("games"."playtime_minutes_manual" IS NULL OR "games"."playtime_minutes_manual" >= 0)
    AND "games"."playtime_minutes_synced" >= 0
  ),
	CONSTRAINT "games_estimates_nonnegative" CHECK (
    ("games"."estimated_hastily_minutes" IS NULL OR "games"."estimated_hastily_minutes" >= 0)
    AND ("games"."estimated_normally_minutes" IS NULL OR "games"."estimated_normally_minutes" >= 0)
    AND ("games"."estimated_completely_minutes" IS NULL OR "games"."estimated_completely_minutes" >= 0)
  ),
	CONSTRAINT "games_date_order" CHECK ("games"."started_at" IS NULL OR "games"."completed_at" IS NULL OR "games"."completed_at" >= "games"."started_at"),
	CONSTRAINT "games_version_positive" CHECK ("games"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"priority_code" text,
	"brand" text,
	"style" text,
	"denier" text,
	"color" text NOT NULL,
	"color_source" text,
	"material" text,
	"composition" text,
	"unit_price" numeric(12, 2),
	"unopened_quantity" integer DEFAULT 0 NOT NULL,
	"opened_quantity" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"repurchase_decision" text,
	"repurchase_source" text,
	"current_location" text,
	"source_batch_id" uuid,
	"source_row" integer,
	"deleted_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_name_length" CHECK (char_length("inventory_items"."product_name") BETWEEN 1 AND 300),
	CONSTRAINT "inventory_items_quantity_nonnegative" CHECK ("inventory_items"."unopened_quantity" >= 0 AND "inventory_items"."opened_quantity" >= 0),
	CONSTRAINT "inventory_items_unit_price_nonnegative" CHECK ("inventory_items"."unit_price" IS NULL OR "inventory_items"."unit_price" >= 0),
	CONSTRAINT "inventory_items_version_positive" CHECK ("inventory_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"unopened_delta" integer DEFAULT 0 NOT NULL,
	"opened_delta" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"source_batch_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_nonzero" CHECK ("inventory_movements"."unopened_delta" <> 0 OR "inventory_movements"."opened_delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"status" "sync_job_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"cursor" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_jobs_counts_nonnegative" CHECK (
    "sync_jobs"."processed_count" >= 0 AND "sync_jobs"."created_count" >= 0 AND "sync_jobs"."updated_count" >= 0 AND "sync_jobs"."skipped_count" >= 0
  ),
	CONSTRAINT "sync_jobs_idempotency_length" CHECK (char_length("sync_jobs"."idempotency_key") BETWEEN 8 AND 200)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_id_assets_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_game_mappings" ADD CONSTRAINT "external_game_mappings_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_import_source_key" ON "assets" USING btree ("source_batch_id","source_row");--> statement-breakpoint
CREATE INDEX "assets_owner_name_idx" ON "assets" USING btree ("owner_user_id","asset_name");--> statement-breakpoint
CREATE INDEX "assets_parent_idx" ON "assets" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_owner_provider_key" ON "external_accounts" USING btree ("owner_user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "external_game_mappings_provider_external_key" ON "external_game_mappings" USING btree ("provider","external_game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_game_mappings_game_provider_key" ON "external_game_mappings" USING btree ("game_id","provider");--> statement-breakpoint
CREATE INDEX "game_play_sessions_game_started_idx" ON "game_play_sessions" USING btree ("game_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "games_import_source_key" ON "games" USING btree ("source_batch_id","source_row");--> statement-breakpoint
CREATE UNIQUE INDEX "games_owner_steam_app_key" ON "games" USING btree ("owner_user_id","steam_app_id");--> statement-breakpoint
CREATE INDEX "games_owner_name_idx" ON "games" USING btree ("owner_user_id","name_zh");--> statement-breakpoint
CREATE INDEX "games_owner_status_idx" ON "games" USING btree ("owner_user_id","play_status");--> statement-breakpoint
CREATE INDEX "games_owner_platform_idx" ON "games" USING btree ("owner_user_id","platform");--> statement-breakpoint
CREATE INDEX "games_owner_deleted_idx" ON "games" USING btree ("owner_user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_import_source_key" ON "inventory_items" USING btree ("source_batch_id","source_row");--> statement-breakpoint
CREATE INDEX "inventory_items_owner_name_idx" ON "inventory_items" USING btree ("owner_user_id","product_name");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_created_idx" ON "inventory_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_owner_idempotency_key" ON "sync_jobs" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_jobs_owner_created_idx" ON "sync_jobs" USING btree ("owner_user_id","created_at");