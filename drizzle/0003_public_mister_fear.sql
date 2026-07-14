CREATE TYPE "public"."steam_library_match_status" AS ENUM('MATCHED', 'UNMATCHED', 'IGNORED');--> statement-breakpoint
CREATE TABLE "steam_library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"steam_app_id" integer NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"playtime_minutes" integer DEFAULT 0 NOT NULL,
	"recent_playtime_minutes" integer,
	"last_played_at" timestamp (3) with time zone,
	"icon_url" text,
	"match_status" "steam_library_match_status" DEFAULT 'UNMATCHED' NOT NULL,
	"matched_game_id" uuid,
	"match_confidence" integer DEFAULT 0 NOT NULL,
	"match_method" text NOT NULL,
	"is_owned" boolean DEFAULT true NOT NULL,
	"last_seen_job_id" uuid,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "steam_library_items_app_id_positive" CHECK ("steam_library_items"."steam_app_id" > 0),
	CONSTRAINT "steam_library_items_name_length" CHECK (char_length("steam_library_items"."name") BETWEEN 1 AND 300),
	CONSTRAINT "steam_library_items_playtime_nonnegative" CHECK (
    "steam_library_items"."playtime_minutes" >= 0
    AND ("steam_library_items"."recent_playtime_minutes" IS NULL OR "steam_library_items"."recent_playtime_minutes" >= 0)
  ),
	CONSTRAINT "steam_library_items_confidence_range" CHECK ("steam_library_items"."match_confidence" BETWEEN 0 AND 100),
	CONSTRAINT "steam_library_items_match_invariant" CHECK (
    ("steam_library_items"."match_status" = 'MATCHED' AND "steam_library_items"."matched_game_id" IS NOT NULL)
    OR ("steam_library_items"."match_status" <> 'MATCHED' AND "steam_library_items"."matched_game_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD CONSTRAINT "steam_library_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD CONSTRAINT "steam_library_items_matched_game_id_games_id_fk" FOREIGN KEY ("matched_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD CONSTRAINT "steam_library_items_last_seen_job_id_sync_jobs_id_fk" FOREIGN KEY ("last_seen_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "steam_library_items_owner_app_key" ON "steam_library_items" USING btree ("owner_user_id","steam_app_id");--> statement-breakpoint
CREATE INDEX "steam_library_items_owner_status_idx" ON "steam_library_items" USING btree ("owner_user_id","match_status","is_owned");--> statement-breakpoint
CREATE INDEX "steam_library_items_matched_game_idx" ON "steam_library_items" USING btree ("matched_game_id");