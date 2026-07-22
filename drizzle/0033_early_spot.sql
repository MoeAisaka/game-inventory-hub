CREATE UNIQUE INDEX "games_owner_id_key" ON "games" USING btree ("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "game_dualsense_profiles" ADD CONSTRAINT "game_dualsense_profiles_owner_game_fk" FOREIGN KEY ("owner_user_id","game_id") REFERENCES "public"."games"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;
