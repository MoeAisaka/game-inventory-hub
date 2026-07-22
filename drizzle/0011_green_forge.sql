ALTER TABLE "games" ADD COLUMN "estimate_source" "data_source";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "hltb_game_id" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "hltb_last_attempt_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "games"
SET "estimate_source" = 'IGDB'
WHERE "estimate_source" IS NULL
  AND "igdb_game_id" IS NOT NULL
  AND ("estimated_hastily_minutes" IS NOT NULL OR "estimated_normally_minutes" IS NOT NULL OR "estimated_completely_minutes" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "games_owner_hltb_game_key" ON "games" USING btree ("owner_user_id","hltb_game_id");
