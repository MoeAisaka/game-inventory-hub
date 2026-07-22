CREATE TYPE "public"."steam_license_type" AS ENUM('OWNED', 'FAMILY_SHARED');--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "search_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD COLUMN "license_type" "steam_license_type" DEFAULT 'OWNED' NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD COLUMN "license_owner_steam_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD COLUMN "family_group_id" text;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD COLUMN "exclude_reason" integer;--> statement-breakpoint
ALTER TABLE "steam_library_items" ADD CONSTRAINT "steam_library_items_exclude_reason_nonnegative" CHECK ("steam_library_items"."exclude_reason" IS NULL OR "steam_library_items"."exclude_reason" >= 0);
