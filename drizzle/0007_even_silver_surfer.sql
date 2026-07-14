CREATE TYPE "public"."game_record_status" AS ENUM('BACKLOG', 'PLAYING', 'PAUSED', 'COMPLETED', 'ABANDONED', 'UNPLANNED', 'UNRELEASED', 'TO_BUY');--> statement-breakpoint
CREATE TABLE "game_status_assignments" (
	"game_id" uuid NOT NULL,
	"status" "game_record_status" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_status_assignments_pkey" PRIMARY KEY("game_id","status")
);
--> statement-breakpoint
ALTER TABLE "game_status_assignments" ADD CONSTRAINT "game_status_assignments_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_status_assignments_status_game_idx" ON "game_status_assignments" USING btree ("status","game_id");--> statement-breakpoint
INSERT INTO "game_status_assignments" ("game_id", "status")
SELECT "id", "play_status"::text::"game_record_status"
FROM "games"
WHERE "play_status" IS NOT NULL
ON CONFLICT DO NOTHING;
