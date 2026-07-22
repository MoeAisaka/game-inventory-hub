DELETE FROM "game_play_plans"
USING "games"
WHERE "game_play_plans"."game_id" = "games"."id"
  AND "game_play_plans"."owner_user_id" = "games"."owner_user_id"
  AND "games"."is_completed" = true;
