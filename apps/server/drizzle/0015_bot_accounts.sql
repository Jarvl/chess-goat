CREATE TABLE "owner_tokens" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "owner_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "owner_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "owner_tokens" ADD CONSTRAINT "owner_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_owner_id" ON "users" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_bot_name" ON "users" USING btree (lower("first_name")) WHERE "users"."owner_id" is not null and "users"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bot_shape" CHECK ("users"."owner_id" is null or ("users"."telegram_user_id" is null and not "users"."is_engine"));
--> statement-breakpoint
-- Stats views (0014): bots are not people, so stats.users excludes them; stats.games gains vs_bot as its LAST column (create or replace can only append); stats.bots lists them by id only.
CREATE OR REPLACE VIEW "stats"."users" AS
SELECT
  "u"."id",
  "u"."created_at",
  "u"."last_seen_at",
  EXISTS (SELECT 1 FROM "public"."games" "g" WHERE "g"."white_id" = "u"."id" OR "g"."black_id" = "u"."id") AS "has_played",
  "u"."deleted_at" IS NOT NULL AS "deleted"
FROM "public"."users" "u"
WHERE NOT "u"."is_engine" AND "u"."owner_id" IS NULL;
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
  ("g"."status" = 'finished' AND "g"."voided_at" IS NULL AND COALESCE("g"."end_reason", '') NOT IN ('abort', 'timeout_abort')) AS "counted",
  EXISTS (SELECT 1 FROM "public"."users" "b" WHERE "b"."owner_id" IS NOT NULL AND "b"."id" IN ("g"."white_id", "g"."black_id")) AS "vs_bot"
FROM "public"."games" "g";
--> statement-breakpoint
CREATE OR REPLACE VIEW "stats"."bots" AS
SELECT "id", "created_at", "deleted_at" IS NOT NULL AS "deleted"
FROM "public"."users"
WHERE "owner_id" IS NOT NULL;
