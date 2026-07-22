DELETE FROM "game_play_plans" AS "plan"
USING "games" AS "game"
WHERE "plan"."game_id" = "game"."id"
  AND "plan"."owner_user_id" = "game"."owner_user_id"
  AND EXISTS (
    SELECT 1
    FROM "game_status_assignments" AS "status"
    WHERE "status"."game_id" = "game"."id"
      AND "status"."status" = 'ABANDONED'
  );
