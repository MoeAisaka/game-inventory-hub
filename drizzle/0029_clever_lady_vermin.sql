CREATE TYPE "public"."game_genre" AS ENUM('ACT', 'ARPG', 'JRPG', 'CRPG', 'SRPG', 'FPS', 'TPS', 'AVG_GAL', 'SLG', 'RTS', 'FIGHTING', 'PLATFORMER', 'ROGUELIKE', 'SIMULATION', 'RACING', 'SPORTS', 'RHYTHM', 'PUZZLE', 'HORROR', 'SURVIVAL', 'SANDBOX', 'MMO', 'PARTY', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."game_metadata_field" ADD VALUE 'PRIMARY_GENRE';--> statement-breakpoint
ALTER TYPE "public"."game_metadata_field" ADD VALUE 'SUB_GENRES';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "primary_genre" "game_genre";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "sub_genres" "game_genre"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "genre_source" "data_source";