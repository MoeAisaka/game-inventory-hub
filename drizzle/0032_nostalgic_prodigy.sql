CREATE TYPE "public"."dualsense_environment" AS ENUM('PS5_CONSOLE', 'PC_USB', 'PC_BLUETOOTH');--> statement-breakpoint
CREATE TABLE "game_dualsense_profiles" (
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"environment" "dualsense_environment" NOT NULL,
	"adaptive_triggers" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL,
	"haptic_feedback" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL,
	"controller_speaker" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL,
	"touchpad" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL,
	"controller_mic" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL,
	"notes" text,
	"source" "data_source" DEFAULT 'IMPORT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_dualsense_profiles_pkey" PRIMARY KEY("game_id","environment"),
	CONSTRAINT "game_dualsense_profiles_version_positive" CHECK ("game_dualsense_profiles"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "game_dualsense_profiles" ADD CONSTRAINT "game_dualsense_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_dualsense_profiles" ADD CONSTRAINT "game_dualsense_profiles_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_dualsense_profiles_owner_environment_idx" ON "game_dualsense_profiles" USING btree ("owner_user_id","environment");--> statement-breakpoint

-- Preserve the old single profile only as the PS5-console truth. PC USB and
-- PC Bluetooth start UNKNOWN because pc_wired_required cannot safely tell us
-- which of the five dimensions work in either environment.
INSERT INTO "game_dualsense_profiles" (
  "owner_user_id", "game_id", "environment",
  "adaptive_triggers", "haptic_feedback", "controller_speaker", "touchpad", "controller_mic",
  "notes", "source"
)
SELECT
  game."owner_user_id",
  game."id",
  environment.value::dualsense_environment,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_adaptive_triggers" ELSE 'UNKNOWN'::dualsense_feature_level END,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_haptic_feedback" ELSE 'UNKNOWN'::dualsense_feature_level END,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_controller_speaker" ELSE 'UNKNOWN'::dualsense_feature_level END,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_touchpad" ELSE 'UNKNOWN'::dualsense_feature_level END,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_controller_mic" ELSE 'UNKNOWN'::dualsense_feature_level END,
  CASE WHEN environment.value = 'PS5_CONSOLE' THEN game."dualsense_notes" ELSE NULL END,
  COALESCE(game."hardware_profile_source", 'IMPORT'::data_source)
FROM "games" AS game
CROSS JOIN (VALUES ('PS5_CONSOLE'), ('PC_USB'), ('PC_BLUETOOTH')) AS environment(value);--> statement-breakpoint

DO $$
BEGIN
  IF (SELECT count(*) FROM "game_dualsense_profiles") <> (SELECT count(*) * 3 FROM "games") THEN
    RAISE EXCEPTION 'DUALSENSE_ENVIRONMENT_BACKFILL_COUNT_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "games" AS game
    LEFT JOIN "game_dualsense_profiles" AS profile ON profile."game_id" = game."id"
    GROUP BY game."id"
    HAVING count(profile."environment") <> 3
  ) THEN
    RAISE EXCEPTION 'DUALSENSE_ENVIRONMENT_BACKFILL_INCOMPLETE';
  END IF;
END $$;
