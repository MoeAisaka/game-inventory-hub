ALTER TABLE "game_release_events" ADD COLUMN "store_provider" text;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "store_external_game_id" text;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "summary_zh" text;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "summary_en" text;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "developers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "publishers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "genres_zh" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "genres_en" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD COLUMN "metadata_fetched_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_store_provider_value" CHECK ("game_release_events"."store_provider" IS NULL OR "game_release_events"."store_provider" IN ('STEAM', 'PLAYSTATION', 'NINTENDO'));--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_developers_array" CHECK (jsonb_typeof("game_release_events"."developers") = 'array');--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_publishers_array" CHECK (jsonb_typeof("game_release_events"."publishers") = 'array');--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_genres_zh_array" CHECK (jsonb_typeof("game_release_events"."genres_zh") = 'array');--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_genres_en_array" CHECK (jsonb_typeof("game_release_events"."genres_en") = 'array');