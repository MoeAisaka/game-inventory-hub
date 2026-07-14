CREATE TYPE "public"."game_rating_source" AS ENUM('MANUAL', 'IGDB', 'IGN', 'XIAOHEIHE');--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "name_en_source" "data_source" DEFAULT 'IMPORT' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "queue_order" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "community_rating" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "community_rating_count" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "critic_rating" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "critic_rating_count" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "rating_source" "game_rating_source";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "rating_updated_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "games" SET "priority_level" = NULL, "priority_rank" = NULL
WHERE "priority_level" IS NOT NULL OR "priority_rank" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_queue_order_range" CHECK ("games"."queue_order" IS NULL OR "games"."queue_order" BETWEEN 1 AND 9999);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_rating_range" CHECK (
    ("games"."community_rating" IS NULL OR "games"."community_rating" BETWEEN 0 AND 100)
    AND ("games"."critic_rating" IS NULL OR "games"."critic_rating" BETWEEN 0 AND 100)
  );--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_rating_counts_nonnegative" CHECK (
    ("games"."community_rating_count" IS NULL OR "games"."community_rating_count" >= 0)
    AND ("games"."critic_rating_count" IS NULL OR "games"."critic_rating_count" >= 0)
  );
