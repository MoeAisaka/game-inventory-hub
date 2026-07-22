CREATE TYPE "public"."game_acquisition_availability" AS ENUM('AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."game_acquisition_channel" AS ENUM('SUBSCRIPTION', 'FAMILY_SHARED', 'PHYSICAL', 'SELF_PURCHASED');--> statement-breakpoint
CREATE TYPE "public"."game_completion_goal" AS ENUM('MAIN', 'EXTRA', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."game_play_scenario" AS ENUM('COMMUTE', 'FIXED');--> statement-breakpoint
CREATE TYPE "public"."game_queue_state" AS ENUM('QUEUED', 'PLAYING');--> statement-breakpoint
CREATE TABLE "game_play_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"scenario" "game_play_scenario" NOT NULL,
	"state" "game_queue_state" DEFAULT 'QUEUED' NOT NULL,
	"acquisition_id" uuid,
	"preferred_device" text,
	"completion_goal" "game_completion_goal" DEFAULT 'EXTRA' NOT NULL,
	"queue_order" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_play_plans_queue_order_range" CHECK ("game_play_plans"."queue_order" IS NULL OR "game_play_plans"."queue_order" BETWEEN 1 AND 9999),
	CONSTRAINT "game_play_plans_device_length" CHECK ("game_play_plans"."preferred_device" IS NULL OR char_length("game_play_plans"."preferred_device") BETWEEN 1 AND 60),
	CONSTRAINT "game_play_plans_version_positive" CHECK ("game_play_plans"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD COLUMN "channel" "game_acquisition_channel";--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD COLUMN "availability" "game_acquisition_availability" DEFAULT 'AVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD COLUMN "offline_capable" boolean;--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_play_plans" ADD CONSTRAINT "game_play_plans_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_play_plans" ADD CONSTRAINT "game_play_plans_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_play_plans" ADD CONSTRAINT "game_play_plans_acquisition_id_game_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."game_acquisitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_play_plans_owner_game_scenario_key" ON "game_play_plans" USING btree ("owner_user_id","game_id","scenario");--> statement-breakpoint
CREATE UNIQUE INDEX "game_play_plans_owner_scenario_playing_key" ON "game_play_plans" USING btree ("owner_user_id","scenario") WHERE "game_play_plans"."state" = 'PLAYING';--> statement-breakpoint
CREATE INDEX "game_play_plans_owner_scenario_queue_idx" ON "game_play_plans" USING btree ("owner_user_id","scenario","state","queue_order");--> statement-breakpoint
CREATE INDEX "game_acquisitions_owner_channel_idx" ON "game_acquisitions" USING btree ("owner_user_id","channel","availability");--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD CONSTRAINT "game_acquisitions_platform_length" CHECK ("game_acquisitions"."platform" IS NULL OR char_length("game_acquisitions"."platform") BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "game_acquisitions" ADD CONSTRAINT "game_acquisitions_version_positive" CHECK ("game_acquisitions"."version" > 0);--> statement-breakpoint
UPDATE "game_acquisitions" AS acquisition
SET "platform" = game."platform",
    "availability" = CASE
      WHEN acquisition."source" = 'STEAM' AND coalesce(acquisition."details"->>'accessType', '') = 'FAMILY_SHARED'
        AND coalesce(acquisition."details"->>'available', 'false') = 'true' THEN 'AVAILABLE'::"game_acquisition_availability"
      WHEN acquisition."is_owned" THEN 'AVAILABLE'::"game_acquisition_availability"
      ELSE 'TEMPORARILY_UNAVAILABLE'::"game_acquisition_availability"
    END,
    "channel" = CASE
      WHEN acquisition."source" = 'STEAM' AND coalesce(acquisition."details"->>'accessType', '') = 'FAMILY_SHARED'
        THEN 'FAMILY_SHARED'::"game_acquisition_channel"
      WHEN acquisition."source" = 'STEAM' AND coalesce(acquisition."details"->>'accessType', 'OWNED') = 'OWNED'
        THEN 'SELF_PURCHASED'::"game_acquisition_channel"
      ELSE acquisition."channel"
    END,
    "offline_capable" = CASE
      WHEN acquisition."source" = 'STEAM' AND coalesce(acquisition."details"->>'accessType', '') = 'FAMILY_SHARED' THEN false
      WHEN game."platform" IN ('NINTENDO_SWITCH', 'NINTENDO_SWITCH_2', 'NINTENDO_SWITCH_FAMILY') THEN true
      ELSE acquisition."offline_capable"
    END
FROM "games" AS game
WHERE game."id" = acquisition."game_id";--> statement-breakpoint
INSERT INTO "game_play_plans" (
  "owner_user_id", "game_id", "scenario", "state", "preferred_device", "completion_goal", "queue_order"
)
SELECT game."owner_user_id", game."id", 'FIXED', 'QUEUED',
       CASE
         WHEN game."platform" = 'PLAYSTATION' THEN 'STUDY_PS5'
         WHEN game."platform" IN ('NINTENDO_SWITCH', 'NINTENDO_SWITCH_2', 'NINTENDO_SWITCH_FAMILY') THEN 'BEDROOM_NS2'
         ELSE 'BEDROOM_5080'
       END,
       'EXTRA', game."queue_order"
FROM "games" AS game
JOIN "game_status_assignments" AS status ON status."game_id" = game."id" AND status."status" = 'BACKLOG'
WHERE game."deleted_at" IS NULL
ON CONFLICT ("owner_user_id", "game_id", "scenario") DO NOTHING;--> statement-breakpoint
WITH active AS (
  SELECT game."owner_user_id", game."id" AS "game_id", game."platform", game."handheld_best", game."last_played_at",
         count(*) OVER (PARTITION BY game."owner_user_id") AS "active_count",
         row_number() OVER (
           PARTITION BY game."owner_user_id"
           ORDER BY CASE WHEN game."handheld_best" OR game."platform" IN ('NINTENDO_SWITCH', 'NINTENDO_SWITCH_2', 'NINTENDO_SWITCH_FAMILY') THEN 0 ELSE 1 END,
                    game."last_played_at" DESC NULLS LAST,
                    game."name_zh"
         ) AS "scenario_rank"
  FROM "games" AS game
  JOIN "game_status_assignments" AS status ON status."game_id" = game."id" AND status."status" = 'PLAYING'
  WHERE game."deleted_at" IS NULL
), selected AS (
  SELECT *, CASE WHEN "active_count" > 1 AND "scenario_rank" = 1 THEN 'COMMUTE'::"game_play_scenario" ELSE 'FIXED'::"game_play_scenario" END AS "target_scenario"
  FROM active
  WHERE ("active_count" = 1 AND "scenario_rank" = 1) OR ("active_count" > 1 AND "scenario_rank" <= 2)
)
INSERT INTO "game_play_plans" (
  "owner_user_id", "game_id", "scenario", "state", "preferred_device", "completion_goal"
)
SELECT "owner_user_id", "game_id", "target_scenario", 'PLAYING',
       CASE
         WHEN "target_scenario" = 'COMMUTE' AND "platform" IN ('NINTENDO_SWITCH', 'NINTENDO_SWITCH_2', 'NINTENDO_SWITCH_FAMILY') THEN 'COMMUTE_NS2'
         WHEN "target_scenario" = 'COMMUTE' THEN 'COMMUTE_GPD'
         WHEN "platform" = 'PLAYSTATION' THEN 'STUDY_PS5'
         WHEN "platform" IN ('NINTENDO_SWITCH', 'NINTENDO_SWITCH_2', 'NINTENDO_SWITCH_FAMILY') THEN 'BEDROOM_NS2'
         ELSE 'BEDROOM_5080'
       END,
       'EXTRA'
FROM selected
ON CONFLICT ("owner_user_id", "game_id", "scenario") DO UPDATE
SET "state" = 'PLAYING', "preferred_device" = EXCLUDED."preferred_device", "updated_at" = now();
