CREATE TYPE "public"."dualsense_feature_level" AS ENUM('NONE', 'BASIC', 'RICH', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."pc_wired_requirement" AS ENUM('TRUE', 'FALSE', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."ray_tracing_level" AS ENUM('NONE', 'RT_BASIC', 'RT_FULL_PATH_TRACING', 'UNKNOWN');--> statement-breakpoint
ALTER TYPE "public"."game_metadata_field" ADD VALUE 'DUALSENSE_PROFILE';--> statement-breakpoint
ALTER TYPE "public"."game_metadata_field" ADD VALUE 'RAY_TRACING_PROFILE';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_adaptive_triggers" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_haptic_feedback" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_controller_speaker" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_touchpad" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_controller_mic" "dualsense_feature_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "dualsense_notes" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "pc_wired_required" "pc_wired_requirement" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "ray_tracing" "ray_tracing_level" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "ray_tracing_notes" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "hardware_profile_source" "data_source";