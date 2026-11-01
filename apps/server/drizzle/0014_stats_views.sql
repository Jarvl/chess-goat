-- Usage dashboard spec: anonymised read-only views for Metabase. A later migration that alters or drops a column one of these views reads must `create or replace` (or drop and recreate) the view in the same migration; Postgres refuses to drop a column a view depends on.
CREATE SCHEMA IF NOT EXISTS "stats";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."users" AS
SELECT
  "u"."id",
  "u"."created_at",
  "u"."last_seen_at",
  EXISTS (SELECT 1 FROM "public"."games" "g" WHERE "g"."white_id" = "u"."id" OR "g"."black_id" = "u"."id") AS "has_played",
  "u"."deleted_at" IS NOT NULL AS "deleted"
FROM "public"."users" "u"
WHERE NOT "u"."is_engine";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."groups" AS
SELECT
  "id",
  "created_at",
  "type",
  "is_forum",
  "bot_status" <> 'left' AS "bot_present"
FROM "public"."groups";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."games" AS
SELECT
  "g"."id",
  "g"."group_id",
  "g"."white_id",
  "g"."black_id",
  "g"."started_at",
  "g"."finished_at",
  "g"."last_move_at",
  "g"."status",
  "g"."end_reason",
  "g"."rated",
  EXISTS (SELECT 1 FROM "public"."users" "e" WHERE "e"."is_engine" AND "e"."id" IN ("g"."white_id", "g"."black_id")) AS "vs_engine",
  "g"."ply_count",
  "g"."voided_at" IS NOT NULL AS "voided",
  ("g"."status" = 'finished' AND "g"."voided_at" IS NULL AND COALESCE("g"."end_reason", '') NOT IN ('abort', 'timeout_abort')) AS "counted"
FROM "public"."games" "g";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."moves" AS
SELECT "game_id", "ply", "played_at"
FROM "public"."moves";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."shares" AS
SELECT "id", "game_id", "user_id", "created_at"
FROM "public"."shares";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."challenges" AS
SELECT "id", "group_id", "created_at", "resolved_at", "status", "rated"
FROM "public"."challenges";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."tips" AS
SELECT
  "id",
  "paid_at",
  "stars",
  "refunded_at" IS NOT NULL AS "refunded"
FROM "public"."tips";
