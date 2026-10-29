ALTER TABLE "games" ADD COLUMN "premove_tree" "bytea" DEFAULT ''::bytea NOT NULL;--> statement-breakpoint
-- Conditional premoves spec, Data and Launch: blind chains cannot become conditional lines, so the
-- ones still queued are dropped. The column itself stays until a later release, so an old container
-- still selecting it during an overlapping deploy keeps working.
UPDATE "games" SET "premoves" = '{}'::text[] WHERE "premoves" <> '{}'::text[];
