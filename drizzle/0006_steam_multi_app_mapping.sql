DROP INDEX "external_game_mappings_game_provider_key";--> statement-breakpoint
CREATE INDEX "external_game_mappings_game_provider_idx" ON "external_game_mappings" USING btree ("game_id","provider");