CREATE TYPE "public"."game_media_source" AS ENUM('MANUAL', 'STEAM');--> statement-breakpoint
CREATE TABLE "game_media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"original_blob_id" uuid NOT NULL,
	"thumbnail_blob_id" uuid NOT NULL,
	"source" "game_media_source" NOT NULL,
	"external_media_id" text,
	"source_url" text,
	"title" text,
	"captured_at" timestamp (3) with time zone,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_media_dimensions_positive" CHECK ("game_media_items"."width" > 0 AND "game_media_items"."height" > 0),
	CONSTRAINT "game_media_sort_order_nonnegative" CHECK ("game_media_items"."sort_order" >= 0),
	CONSTRAINT "game_media_title_length" CHECK ("game_media_items"."title" IS NULL OR char_length("game_media_items"."title") BETWEEN 1 AND 500),
	CONSTRAINT "game_media_steam_external_required" CHECK ("game_media_items"."source" <> 'STEAM' OR "game_media_items"."external_media_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "game_media_items" ADD CONSTRAINT "game_media_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_media_items" ADD CONSTRAINT "game_media_items_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_media_items" ADD CONSTRAINT "game_media_items_original_blob_id_file_blobs_id_fk" FOREIGN KEY ("original_blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_media_items" ADD CONSTRAINT "game_media_items_thumbnail_blob_id_file_blobs_id_fk" FOREIGN KEY ("thumbnail_blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_media_owner_blob_key" ON "game_media_items" USING btree ("owner_user_id","original_blob_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_media_owner_source_external_key" ON "game_media_items" USING btree ("owner_user_id","source","external_media_id") WHERE "game_media_items"."external_media_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "game_media_owner_active_idx" ON "game_media_items" USING btree ("owner_user_id","deleted_at","captured_at");--> statement-breakpoint
CREATE INDEX "game_media_game_active_idx" ON "game_media_items" USING btree ("game_id","deleted_at","sort_order");