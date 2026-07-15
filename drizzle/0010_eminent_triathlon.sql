CREATE TYPE "public"."platform_library_match_status" AS ENUM('MATCHED', 'UNMATCHED', 'IGNORED');--> statement-breakpoint
CREATE TABLE "platform_library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"external_game_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text,
	"cover_url" text,
	"playtime_minutes" integer DEFAULT 0 NOT NULL,
	"first_played_at" timestamp (3) with time zone,
	"last_played_at" timestamp (3) with time zone,
	"progress_percent" integer,
	"is_owned" boolean DEFAULT true NOT NULL,
	"match_status" "platform_library_match_status" DEFAULT 'UNMATCHED' NOT NULL,
	"matched_game_id" uuid,
	"match_confidence" integer DEFAULT 0 NOT NULL,
	"match_method" text DEFAULT 'UNMATCHED' NOT NULL,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_library_items_provider_value" CHECK ("platform_library_items"."provider" IN ('PLAYSTATION', 'NINTENDO')),
	CONSTRAINT "platform_library_items_external_id_length" CHECK (char_length("platform_library_items"."external_game_id") BETWEEN 1 AND 300),
	CONSTRAINT "platform_library_items_name_length" CHECK (char_length("platform_library_items"."name") BETWEEN 1 AND 300),
	CONSTRAINT "platform_library_items_playtime_nonnegative" CHECK ("platform_library_items"."playtime_minutes" >= 0),
	CONSTRAINT "platform_library_items_progress_range" CHECK ("platform_library_items"."progress_percent" IS NULL OR "platform_library_items"."progress_percent" BETWEEN 0 AND 100),
	CONSTRAINT "platform_library_items_confidence_range" CHECK ("platform_library_items"."match_confidence" BETWEEN 0 AND 100),
	CONSTRAINT "platform_library_items_match_invariant" CHECK (
    ("platform_library_items"."match_status" = 'MATCHED' AND "platform_library_items"."matched_game_id" IS NOT NULL)
    OR ("platform_library_items"."match_status" <> 'MATCHED' AND "platform_library_items"."matched_game_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "purchase_url" text;--> statement-breakpoint
UPDATE "inventory_items"
SET
  "purchase_url" = (regexp_match("product_name", E'(https?://[^[:space:]｜;,，；]+)[[:space:]]*$'))[1],
  "product_name" = btrim(regexp_replace("product_name", E'[[:space:]｜;,，；]+https?://[^[:space:]｜;,，；]+[[:space:]]*$', '')),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE "purchase_url" IS NULL
  AND "product_name" ~ E'[[:space:]｜;,，；]+https?://[^[:space:]｜;,，；]+[[:space:]]*$';--> statement-breakpoint
ALTER TABLE "platform_library_items" ADD CONSTRAINT "platform_library_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_library_items" ADD CONSTRAINT "platform_library_items_matched_game_id_games_id_fk" FOREIGN KEY ("matched_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_library_items_owner_provider_game_key" ON "platform_library_items" USING btree ("owner_user_id","provider","external_game_id");--> statement-breakpoint
CREATE INDEX "platform_library_items_owner_provider_status_idx" ON "platform_library_items" USING btree ("owner_user_id","provider","match_status");--> statement-breakpoint
CREATE INDEX "platform_library_items_matched_game_idx" ON "platform_library_items" USING btree ("matched_game_id");--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_purchase_url" CHECK ("inventory_items"."purchase_url" IS NULL OR (char_length("inventory_items"."purchase_url") BETWEEN 8 AND 2048 AND "inventory_items"."purchase_url" ~ '^https?://'));
