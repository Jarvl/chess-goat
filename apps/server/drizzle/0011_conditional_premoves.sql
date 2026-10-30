ALTER TABLE "games" ADD COLUMN "premove_tree" "bytea" DEFAULT ''::bytea NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "premove_tree_ply" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Conditional premoves spec, Data: a stored tree counts only while premove_tree_ply equals
-- ply_count, so a tree left behind by a container that ignores trees stays inert.
-- Conditional premoves spec, Data and Launch: blind chains cannot become conditional lines, so the
-- ones still queued are dropped. The column itself stays until a later release, so an old container
-- still selecting it during an overlapping deploy keeps working.
UPDATE "games" SET "premoves" = '{}'::text[] WHERE "premoves" <> '{}'::text[];
