ALTER TABLE "games" ADD COLUMN "is_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "games" AS game
SET "is_completed" = true
WHERE game."completed_at" IS NOT NULL
   OR game."play_status" = 'COMPLETED'
   OR EXISTS (
     SELECT 1 FROM "game_status_assignments" AS assignment
     WHERE assignment."game_id" = game."id" AND assignment."status" = 'COMPLETED'
   );--> statement-breakpoint
UPDATE "games" SET "play_status" = NULL WHERE "play_status" = 'COMPLETED';--> statement-breakpoint
DELETE FROM "game_status_assignments" WHERE "status" = 'COMPLETED';--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_completion_date_requires_fact" CHECK ("games"."completed_at" IS NULL OR "games"."is_completed");
