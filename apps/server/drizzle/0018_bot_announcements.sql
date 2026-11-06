CREATE TABLE "bot_announcements" (
	"bot_id" bigint NOT NULL,
	"group_id" bigint NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_announcements_bot_id_group_id_pk" PRIMARY KEY("bot_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "bot_announcements" ADD CONSTRAINT "bot_announcements_bot_id_users_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_announcements" ADD CONSTRAINT "bot_announcements_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;