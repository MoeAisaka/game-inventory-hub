CREATE TYPE "public"."game_metadata_field" AS ENUM('NAME_ZH', 'NAME_EN', 'COVER_URL', 'RELEASE_DATE', 'COMMUNITY_RATING', 'CRITIC_RATING', 'MAIN_STORY_MINUTES', 'EXTRA_STORY_MINUTES', 'COMPLETIONIST_MINUTES');--> statement-breakpoint
CREATE TYPE "public"."metadata_candidate_status" AS ENUM('PENDING', 'APPLIED', 'REJECTED', 'STALE');--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'RAWG';--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'HLTB';--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'WIKIDATA';--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'STEAMGRIDDB';--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'PLAYSTATION';--> statement-breakpoint
ALTER TYPE "public"."data_source" ADD VALUE 'NINTENDO';--> statement-breakpoint
ALTER TYPE "public"."external_provider" ADD VALUE 'RAWG' BEFORE 'PLAYSTATION';--> statement-breakpoint
ALTER TYPE "public"."external_provider" ADD VALUE 'HLTB' BEFORE 'PLAYSTATION';--> statement-breakpoint
ALTER TYPE "public"."external_provider" ADD VALUE 'WIKIDATA' BEFORE 'PLAYSTATION';--> statement-breakpoint
ALTER TYPE "public"."external_provider" ADD VALUE 'STEAMGRIDDB' BEFORE 'PLAYSTATION';--> statement-breakpoint
ALTER TYPE "public"."game_rating_source" ADD VALUE 'STEAM' BEFORE 'IGDB';--> statement-breakpoint
ALTER TYPE "public"."game_rating_source" ADD VALUE 'RAWG' BEFORE 'IGN';--> statement-breakpoint
ALTER TYPE "public"."game_rating_source" ADD VALUE 'METACRITIC' BEFORE 'IGN';--> statement-breakpoint
CREATE TABLE "game_acquisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"source" "data_source" NOT NULL,
	"external_acquisition_id" text,
	"acquired_at" timestamp (3) with time zone,
	"is_owned" boolean DEFAULT true NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_confirmed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_acquisitions_external_id_length" CHECK ("game_acquisitions"."external_acquisition_id" IS NULL OR char_length("game_acquisitions"."external_acquisition_id") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE "game_activity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"external_game_id" text NOT NULL,
	"total_playtime_minutes" integer DEFAULT 0 NOT NULL,
	"recent_playtime_minutes" integer,
	"last_played_at" timestamp (3) with time zone,
	"observed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_activity_snapshots_playtime_nonnegative" CHECK (
    "game_activity_snapshots"."total_playtime_minutes" >= 0
    AND ("game_activity_snapshots"."recent_playtime_minutes" IS NULL OR "game_activity_snapshots"."recent_playtime_minutes" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE "game_field_locks" (
	"game_id" uuid NOT NULL,
	"field" "game_metadata_field" NOT NULL,
	"locked_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_field_locks_pkey" PRIMARY KEY("game_id","field")
);
--> statement-breakpoint
CREATE TABLE "game_metadata_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"provider" "data_source" NOT NULL,
	"external_game_id" text NOT NULL,
	"field" "game_metadata_field" NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"status" "metadata_candidate_status" DEFAULT 'PENDING' NOT NULL,
	"fetched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_metadata_candidates_confidence_range" CHECK ("game_metadata_candidates"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "game_release_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid,
	"source" "data_source" NOT NULL,
	"dedupe_key" text NOT NULL,
	"external_game_id" text,
	"name_zh" text NOT NULL,
	"name_en" text,
	"platform" text NOT NULL,
	"release_date" date NOT NULL,
	"region" text DEFAULT 'GLOBAL' NOT NULL,
	"is_announced" boolean DEFAULT true NOT NULL,
	"store_url" text,
	"cover_url" text,
	"fetched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_release_events_name_length" CHECK (char_length("game_release_events"."name_zh") BETWEEN 1 AND 300),
	CONSTRAINT "game_release_events_platform_length" CHECK (char_length("game_release_events"."platform") BETWEEN 1 AND 100),
	CONSTRAINT "game_release_events_dedupe_length" CHECK (char_length("game_release_events"."dedupe_key") BETWEEN 3 AND 500)
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "cover_url_source" "data_source";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "first_observed_played_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "playtime_last_changed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD CONSTRAINT "game_acquisitions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD CONSTRAINT "game_acquisitions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_activity_snapshots" ADD CONSTRAINT "game_activity_snapshots_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_activity_snapshots" ADD CONSTRAINT "game_activity_snapshots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_field_locks" ADD CONSTRAINT "game_field_locks_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_field_locks" ADD CONSTRAINT "game_field_locks_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_metadata_candidates" ADD CONSTRAINT "game_metadata_candidates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_metadata_candidates" ADD CONSTRAINT "game_metadata_candidates_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_release_events" ADD CONSTRAINT "game_release_events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_acquisitions_source_external_key" ON "game_acquisitions" USING btree ("owner_user_id","source","external_acquisition_id");--> statement-breakpoint
CREATE INDEX "game_acquisitions_game_owned_idx" ON "game_acquisitions" USING btree ("game_id","is_owned");--> statement-breakpoint
CREATE UNIQUE INDEX "game_activity_snapshots_observation_key" ON "game_activity_snapshots" USING btree ("owner_user_id","provider","external_game_id","observed_at");--> statement-breakpoint
CREATE INDEX "game_activity_snapshots_game_observed_idx" ON "game_activity_snapshots" USING btree ("game_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_metadata_candidates_source_field_key" ON "game_metadata_candidates" USING btree ("game_id","provider","external_game_id","field");--> statement-breakpoint
CREATE INDEX "game_metadata_candidates_owner_status_idx" ON "game_metadata_candidates" USING btree ("owner_user_id","status","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_release_events_owner_dedupe_key" ON "game_release_events" USING btree ("owner_user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "game_release_events_owner_date_idx" ON "game_release_events" USING btree ("owner_user_id","release_date","platform");
--> statement-breakpoint
UPDATE "games"
SET "cover_url_source" = CASE
  WHEN "cover_url" LIKE '%steampowered.com%' OR "cover_url" LIKE '%steamstatic.com%' THEN 'STEAM'::"data_source"
  WHEN "cover_url" LIKE '%igdb.com%' THEN 'IGDB'::"data_source"
  ELSE 'IMPORT'::"data_source"
END
WHERE "cover_url" IS NOT NULL AND "cover_url_source" IS NULL;
--> statement-breakpoint
INSERT INTO "game_acquisitions" (
  "owner_user_id", "game_id", "source", "external_acquisition_id", "is_owned", "details", "last_confirmed_at"
)
SELECT
  sli."owner_user_id",
  sli."matched_game_id",
  'STEAM'::"data_source",
  sli."steam_app_id"::text,
  sli."is_owned",
  jsonb_build_object('steamAppId', sli."steam_app_id", 'title', sli."name", 'backfilled', true),
  sli."last_seen_at"
FROM "steam_library_items" sli
WHERE sli."matched_game_id" IS NOT NULL AND sli."match_status" = 'MATCHED'
ON CONFLICT ("owner_user_id", "source", "external_acquisition_id") DO UPDATE SET
  "game_id" = EXCLUDED."game_id",
  "is_owned" = EXCLUDED."is_owned",
  "last_confirmed_at" = EXCLUDED."last_confirmed_at",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "game_acquisitions" (
  "owner_user_id", "game_id", "source", "external_acquisition_id", "is_owned", "details"
)
SELECT
  g."owner_user_id",
  g."id",
  'IMPORT'::"data_source",
  'legacy:' || g."id"::text,
  true,
  jsonb_build_object('ownershipStatus', g."ownership_status", 'backfilled', true)
FROM "games" g
WHERE g."deleted_at" IS NULL
  AND g."ownership_status" = 'OWNED'
  AND NOT EXISTS (
    SELECT 1 FROM "game_acquisitions" ga WHERE ga."game_id" = g."id" AND ga."is_owned" = true
  )
ON CONFLICT ("owner_user_id", "source", "external_acquisition_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "game_activity_snapshots" (
  "owner_user_id", "game_id", "provider", "external_game_id", "total_playtime_minutes",
  "recent_playtime_minutes", "last_played_at", "observed_at"
)
SELECT
  sli."owner_user_id",
  sli."matched_game_id",
  'STEAM'::"external_provider",
  sli."steam_app_id"::text,
  sli."playtime_minutes",
  sli."recent_playtime_minutes",
  sli."last_played_at",
  sli."last_seen_at"
FROM "steam_library_items" sli
WHERE sli."matched_game_id" IS NOT NULL AND sli."match_status" = 'MATCHED'
ON CONFLICT ("owner_user_id", "provider", "external_game_id", "observed_at") DO NOTHING;
--> statement-breakpoint
UPDATE "games" g
SET
  "first_observed_played_at" = COALESCE(g."first_observed_played_at", observed."first_observed_at"),
  "playtime_last_changed_at" = COALESCE(g."playtime_last_changed_at", observed."last_observed_at")
FROM (
  SELECT
    sli."matched_game_id" AS "game_id",
    min(sli."created_at") FILTER (WHERE sli."playtime_minutes" > 0) AS "first_observed_at",
    max(sli."updated_at") FILTER (WHERE sli."playtime_minutes" > 0) AS "last_observed_at"
  FROM "steam_library_items" sli
  WHERE sli."matched_game_id" IS NOT NULL AND sli."match_status" = 'MATCHED'
  GROUP BY sli."matched_game_id"
) observed
WHERE g."id" = observed."game_id";
--> statement-breakpoint
INSERT INTO "game_release_events" (
  "owner_user_id", "game_id", "source", "dedupe_key", "external_game_id", "name_zh", "name_en",
  "platform", "release_date", "region", "cover_url"
)
SELECT
  g."owner_user_id",
  g."id",
  g."release_date_source",
  'game:' || g."id"::text || ':primary',
  COALESCE(g."steam_app_id"::text, g."igdb_game_id"::text),
  g."name_zh",
  g."name_en",
  g."platform",
  g."release_date",
  'GLOBAL',
  g."cover_url"
FROM "games" g
WHERE g."deleted_at" IS NULL AND g."release_date" IS NOT NULL AND g."platform" IS NOT NULL
ON CONFLICT ("owner_user_id", "dedupe_key") DO NOTHING;
