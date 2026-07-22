CREATE TABLE "platform_wishlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"external_game_id" text NOT NULL,
	"name" text NOT NULL,
	"priority" integer,
	"added_at" timestamp (3) with time zone,
	"platform" text,
	"cover_url" text,
	"release_date" date,
	"release_date_precision" text DEFAULT 'DAY' NOT NULL,
	"store_url" text,
	"matched_game_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_wishlist_items_provider_value" CHECK ("platform_wishlist_items"."provider" IN ('STEAM', 'PLAYSTATION', 'NINTENDO')),
	CONSTRAINT "platform_wishlist_items_external_id_length" CHECK (char_length("platform_wishlist_items"."external_game_id") BETWEEN 1 AND 200),
	CONSTRAINT "platform_wishlist_items_name_length" CHECK (char_length("platform_wishlist_items"."name") BETWEEN 1 AND 300),
	CONSTRAINT "platform_wishlist_items_priority_nonnegative" CHECK ("platform_wishlist_items"."priority" IS NULL OR "platform_wishlist_items"."priority" >= 0),
	CONSTRAINT "platform_wishlist_items_date_precision_value" CHECK ("platform_wishlist_items"."release_date_precision" IN ('DAY', 'MONTH', 'QUARTER', 'YEAR'))
);
--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "date_precision" text DEFAULT 'DAY' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_wishlist_items" ADD CONSTRAINT "platform_wishlist_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_wishlist_items" ADD CONSTRAINT "platform_wishlist_items_matched_game_id_games_id_fk" FOREIGN KEY ("matched_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_wishlist_items_owner_provider_game_key" ON "platform_wishlist_items" USING btree ("owner_user_id","provider","external_game_id");--> statement-breakpoint
CREATE INDEX "platform_wishlist_items_owner_provider_active_idx" ON "platform_wishlist_items" USING btree ("owner_user_id","provider","is_active");--> statement-breakpoint
CREATE INDEX "platform_wishlist_items_matched_game_idx" ON "platform_wishlist_items" USING btree ("matched_game_id");--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_date_precision_value" CHECK ("game_release_events"."date_precision" IN ('DAY', 'MONTH', 'QUARTER', 'YEAR'));