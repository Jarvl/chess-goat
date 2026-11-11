CREATE TABLE "match_notes" (
	"bot_id" bigint NOT NULL,
	"game_id" bigint NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "match_notes_bot_id_game_id_pk" PRIMARY KEY("bot_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "runner_link_codes" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"label" text,
	"bot_ids" bigint[],
	"preset" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runners_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_id" bigint NOT NULL,
	"label" text NOT NULL,
	"harness" text,
	"bot_ids" bigint[],
	"credential_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "runners_credentialHash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "turn_leases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "turn_leases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bot_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"game_id" bigint,
	"challenge_id" bigint,
	"ply" integer,
	"runner_id" bigint,
	"leased_until" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"claimable_at" timestamp with time zone DEFAULT now() NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"notes_revision_seen" integer,
	"expires_at" timestamp with time zone,
	"hello_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_notes_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_notes" ADD CONSTRAINT "match_notes_bot_id_users_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_notes" ADD CONSTRAINT "match_notes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_link_codes" ADD CONSTRAINT "runner_link_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_leases" ADD CONSTRAINT "turn_leases_bot_id_users_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_leases" ADD CONSTRAINT "turn_leases_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_leases" ADD CONSTRAINT "turn_leases_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_leases" ADD CONSTRAINT "turn_leases_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_leases_turn" ON "turn_leases" USING btree ("bot_id","kind",coalesce("game_id", 0),coalesce("challenge_id", 0),coalesce("ply", -1));