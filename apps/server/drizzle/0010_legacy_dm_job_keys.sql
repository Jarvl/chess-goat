-- `send_dm` jobs are keyed per player and game (`dm:{user}:g:{game}`),
-- where they used to be keyed per ply (`…:turn:{ply}`, `…:reminder:{ply}`). Pending jobs queued
-- before the deploy are moved to the new key so they merge with new ones instead of sending twice;
-- where one player and game has several, the newest is kept, since DMs are built from current state.
DELETE FROM "jobs" AS "older"
USING "jobs" AS "newer"
WHERE "older"."kind" = 'send_dm'
  AND "newer"."kind" = 'send_dm'
  AND "older"."done_at" IS NULL
  AND "newer"."done_at" IS NULL
  AND "older"."id" < "newer"."id"
  AND "older"."dedup_key" ~ '^dm:\d+:g:[^:]+(:(turn|reminder):\d+)?$'
  AND "newer"."dedup_key" ~ '^dm:\d+:g:[^:]+(:(turn|reminder):\d+)?$'
  AND regexp_replace("older"."dedup_key", ':(turn|reminder):\d+$', '')
    = regexp_replace("newer"."dedup_key", ':(turn|reminder):\d+$', '');
--> statement-breakpoint
UPDATE "jobs"
SET "dedup_key" = regexp_replace("dedup_key", ':(turn|reminder):\d+$', '')
WHERE "kind" = 'send_dm'
  AND "done_at" IS NULL
  AND "dedup_key" ~ '^dm:\d+:g:[^:]+:(turn|reminder):\d+$';
