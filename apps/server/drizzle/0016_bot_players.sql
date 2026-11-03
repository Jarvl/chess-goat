ALTER TABLE "challenges" ADD COLUMN "bot_players" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "bot_players" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "games_bot_vs_bot_stale" ON "games" USING btree (coalesce("last_move_at", "started_at")) WHERE "games"."status" = 'active' and "games"."bot_players" = 2 and "games"."time_per_move" is null;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_bot_players_range" CHECK ("challenges"."bot_players" between 0 and 2);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_bot_players_range" CHECK ("games"."bot_players" between 0 and 2);