CREATE TABLE "challenge_prompts" (
	"group_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"time_per_move" integer NOT NULL,
	"colour" text NOT NULL,
	"rated" boolean NOT NULL,
	"thread_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_prompts_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "challenge_prompts" ADD CONSTRAINT "challenge_prompts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_prompts" ADD CONSTRAINT "challenge_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;