CREATE INDEX "match_notes_game" ON "match_notes" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "turn_leases_runner" ON "turn_leases" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "turn_leases_game" ON "turn_leases" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "turn_leases_challenge" ON "turn_leases" USING btree ("challenge_id");