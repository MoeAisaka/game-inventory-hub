CREATE TABLE "game_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"source" "game_rating_source" NOT NULL,
	"kind" text NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"rating_count" integer,
	"source_url" text,
	"fetched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_ratings_kind_value" CHECK ("game_ratings"."kind" IN ('COMMUNITY', 'CRITIC')),
	CONSTRAINT "game_ratings_score_range" CHECK ("game_ratings"."score" BETWEEN 0 AND 100),
	CONSTRAINT "game_ratings_count_nonnegative" CHECK ("game_ratings"."rating_count" IS NULL OR "game_ratings"."rating_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "game_ratings" ADD CONSTRAINT "game_ratings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_ratings" ADD CONSTRAINT "game_ratings_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_ratings_game_source_kind_key" ON "game_ratings" USING btree ("game_id","source","kind");--> statement-breakpoint
CREATE INDEX "game_ratings_owner_source_idx" ON "game_ratings" USING btree ("owner_user_id","source");
--> statement-breakpoint
INSERT INTO "game_ratings" ("owner_user_id", "game_id", "source", "kind", "score", "rating_count", "fetched_at")
SELECT
  "owner_user_id",
  "id",
  COALESCE("rating_source", 'MANUAL'::"game_rating_source"),
  'COMMUNITY',
  "community_rating",
  "community_rating_count",
  COALESCE("rating_updated_at", "updated_at")
FROM "games"
WHERE "community_rating" IS NOT NULL
ON CONFLICT ("game_id", "source", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "game_ratings" ("owner_user_id", "game_id", "source", "kind", "score", "rating_count", "fetched_at")
SELECT
  "owner_user_id",
  "id",
  COALESCE("rating_source", 'MANUAL'::"game_rating_source"),
  'CRITIC',
  "critic_rating",
  "critic_rating_count",
  COALESCE("rating_updated_at", "updated_at")
FROM "games"
WHERE "critic_rating" IS NOT NULL
ON CONFLICT ("game_id", "source", "kind") DO NOTHING;
