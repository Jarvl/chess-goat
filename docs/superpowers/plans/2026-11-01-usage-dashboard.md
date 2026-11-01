# Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `/metrics` behind a token, add anonymised `stats.*` views a read-only Metabase user can query, and document the Metabase setup and dashboard.

**Architecture:** One config flag and a guard on the existing `/metrics` route. One hand-written drizzle migration that creates a `stats` schema of row-level views over the public tables, exposing only ids, timestamps and categories. Metabase itself, its database user and its dashboard are operator steps, written up in the docs; no app code talks to Metabase.

**Tech Stack:** TypeScript, Hono, zod config, drizzle-orm/drizzle-kit migrations on PostgreSQL 18, vitest integration tests against `TEST_DATABASE_URL`.

**Spec:** `docs/superpowers/specs/2026-11-01-usage-dashboard-design.md`

## Global Constraints

- **Never read, print or log a database connection URI** (`DATABASE_URL`, Dokploy PostgreSQL connection strings, `.env`). Docs and SQL use placeholders (`<password>`, `<database>`). Tests get their URL from `TEST_DATABASE_URL` through the existing helpers and never print it.
- Free, open-source Metabase only: a `v0.x` image tag, never `metabase/metabase-enterprise` or a `v1.x` tag.
- No `stats.*` view exposes names, usernames, Telegram ids, photos, DM text, move text, payment charge ids or card/message ids.
- `METRICS_TOKEN`: optional, at least 32 characters. Unset means `/metrics` returns 404. When it's set, the request must send `Authorization: Bearer <token>`, compared in constant time, and anything else gets 404.
- The stats migration uses `create schema if not exists stats` and `create or replace view`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Engine user counted as a person.** The engine must not show up in `stats.users`. Distinct-player counts built by joining `stats.games` to `stats.users` must therefore drop it. Covered by a Task 2 test.
2. **Staging reset.** `drop schema public cascade` drops the views and leaves an empty `stats` schema. The next migration run must recreate the views, and the reader role must still be able to select from them through its default privileges. Covered by a Task 2 test.
3. **Null-valued flags on active games.** `counted`, `voided`, `vs_engine` and `refunded` must be `true`/`false` and never `null` for active games, games without an end reason or unrefunded tips. Metabase filters treat `null` as neither. Covered by a Task 2 test.
4. **A token of the wrong length.** `timingSafeEqual` throws on unequal lengths, so a short or long bearer token must get 404, never 500. Covered by a Task 1 test.
5. **Users who deleted their data.** They must still count in `stats.users` with `deleted = true`, and still count for `has_played`. Covered by a Task 2 test.

---

### Task 1: `/metrics` behind `METRICS_TOKEN`

**Files:**
- Modify: `apps/server/src/config.ts` (add `METRICS_TOKEN` to `ConfigSchema`)
- Modify: `apps/server/src/api/routes/health.ts` (guard `/metrics`)
- Modify: `apps/server/test/helpers/config.ts` (`METRICS_TOKEN: undefined` in `testConfig`)
- Modify: `.env.example`, `docs/deploy-dokploy.md` (env table and the "Close off `/metrics`" paragraph), `docs/operations.md` (the `Metrics: GET /metrics` line)
- Test: `apps/server/test/integration/metrics-access.test.ts`; `apps/server/test/unit/config.test.ts`

**Interfaces:**
- Consumes: `startTestApi(db, extra, configOverrides)` from `test/helpers/api.ts`. `createApiApp` mounts `healthRoutes(ctx)` at `/` (`src/api/app.ts:46`), so `api.request('GET', '/metrics', { headers })` reaches the route.
- Produces: `Config['METRICS_TOKEN']: string | undefined`.

- [ ] **Step 1: Write the failing tests**

In `metrics-access.test.ts`, one `startTestApi` per config:
- `it('hides /metrics when no token is configured')`: `GET /metrics` returns status 404, both with no header and with `Authorization: Bearer <any 32+ chars>`.
- `it('hides /metrics from a missing, wrong or wrong-length token')`, with `METRICS_TOKEN = 'm'.repeat(40)`:
  - no header → 404
  - `Bearer ${'x'.repeat(40)}` → 404
  - `Bearer short` → 404 (not 500)
  - `Bearer ${'m'.repeat(41)}` → 404
  - `Basic ${'m'.repeat(40)}` → 404
- `it('serves /metrics to the right bearer token')`: `Bearer ${'m'.repeat(40)}` returns status 200, and the body contains `moves_total`.

In `config.test.ts`: `loadConfig` with `METRICS_TOKEN: 'short'` throws an error mentioning `METRICS_TOKEN`; omitting it gives `undefined`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @chess-goat/server exec vitest run test/integration/metrics-access.test.ts test/unit/config.test.ts`
Expected: FAIL. The "no token" case returns 200, and the config case doesn't throw.

- [ ] **Step 3: Implement**

- In `ConfigSchema`, add `METRICS_TOKEN: z.string().min(32).optional()` with a doc comment: "Bearer token for `GET /metrics`; unset hides the endpoint (404)."
- In `health.ts`, return `c.notFound()` unless `config.METRICS_TOKEN` is set and the `authorization` header equals `Bearer <token>`. Compare with a length check followed by `timingSafeEqual`, the same shape as `secretMatches` in `src/bot/webhook.ts`. Keep the helper local; don't export it from webhook.
- In `testConfig`, add `METRICS_TOKEN: undefined`.

- [ ] **Step 4: Run the tests to see them pass**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Update the docs**

- `.env.example`: `# METRICS_TOKEN=   # 32+ chars; unset hides /metrics (404). Prometheus sends it as a Bearer token.`
- `docs/deploy-dokploy.md`:
  - Add a row to the env table: `METRICS_TOKEN` | optional; `openssl rand -hex 32`.
  - Replace the "Close off `/metrics`" paragraph: `/metrics` is now hidden unless `METRICS_TOKEN` is set, and then it needs `Authorization: Bearer <token>`.
- `docs/operations.md`: make the same change to the `Metrics: GET /metrics (Prometheus); keep it behind the network policy.` sentence.

- [ ] **Step 6: Run the whole server suite and lint**

Run: `pnpm --filter @chess-goat/server test && pnpm lint`
Expected: everything passes. `main.test.ts` and any other test that builds a config must still compile with the new key.

- [ ] **Step 7: Commit**

`git commit -m "Hide /metrics unless METRICS_TOKEN is set and sent as a bearer token"` (with the trailer).

---

### Task 2: `stats` schema of anonymised views, and the reader-role runbook

**Files:**
- Create: `apps/server/drizzle/0014_stats_views.sql`, plus its journal entry and snapshot, generated with `pnpm --filter @chess-goat/server exec drizzle-kit generate --custom --name stats_views`. That writes an empty SQL file and a snapshot identical to 0013's. `generate` doesn't connect to a database, so no URL is needed.
- Modify: `docs/operations.md` (new "Usage dashboard database user" runbook entry)
- Test: `apps/server/test/integration/stats-views.test.ts`

**Interfaces:**
- Consumes: `scratchDatabase(name)` and `runMigrations(url, { migrationsFolder?, resetOnMismatch? })` from the existing helpers.
- Produces: these views, with exactly these columns (later docs and Metabase rely on the names):

| View | Columns, in order |
|---|---|
| `stats.users` | `id`, `created_at`, `last_seen_at`, `has_played`, `deleted` |
| `stats.groups` | `id`, `created_at`, `type`, `is_forum`, `bot_present` |
| `stats.games` | `id`, `group_id`, `white_id`, `black_id`, `started_at`, `finished_at`, `last_move_at`, `status`, `end_reason`, `rated`, `vs_engine`, `ply_count`, `voided`, `counted` |
| `stats.moves` | `game_id`, `ply`, `played_at` |
| `stats.shares` | `id`, `game_id`, `user_id`, `created_at` |
| `stats.challenges` | `id`, `group_id`, `created_at`, `resolved_at`, `status`, `rated` |
| `stats.tips` | `id`, `paid_at`, `stars`, `refunded` |

How each derived column is defined. Every boolean must be non-null:
- `users`: rows where `not is_engine`. `deleted = deleted_at is not null`. `has_played` = the user is `white_id` or `black_id` of any game.
- `groups.bot_present = bot_status <> 'left'`.
- `games`:
  - `vs_engine`: `white_id` or `black_id` is the engine user (`users.is_engine`).
  - `voided = voided_at is not null`.
  - `counted = status = 'finished' and voided_at is null and coalesce(end_reason, '') not in ('abort', 'timeout_abort')`.
- `tips.refunded = refunded_at is not null`.

- [ ] **Step 1: Write the failing tests**

`stats-views.test.ts` migrates one `scratchDatabase('stats_views')` with the real migrations in `beforeAll`. It also creates a role named `stats_reader_test_${process.pid}`, `nologin`, by running the runbook's grant statements from Step 5 with that name. `afterAll` drops the database, then the role (`drop owned by …; drop role …`). The tests:

- `it('exposes exactly the agreed columns')`:
  - For each view, `information_schema.columns` where `table_schema = 'stats'`, ordered by `ordinal_position`, equals the column list above.
  - The set of views in `stats` is exactly those seven.
- `it('counts people, leaving out the engine and keeping deleted users flagged')`. Insert:
  - Alice, who played a game
  - Bob, who played and then has `deleted_at` set
  - Carol, who never played
  - the engine row from migration 0002, which already exists

  Then `stats.users` has 3 rows. `has_played` is true for Alice and Bob and false for Carol. `deleted` is true only for Bob. No row has the engine's id.
- `it('classifies games')`. Insert:
  - an active human game
  - a finished checkmate game
  - a finished `abort` game
  - a finished voided game
  - an active game against the engine

  Expect:
  - `counted` is true only for the checkmate game
  - `voided` is true only for the voided game
  - `vs_engine` is true only for the engine game
  - none of `counted`, `voided`, `vs_engine` is null in any row
- `it('flags groups without the bot and refunded tips')`:
  - A group with `bot_status = 'left'` gets `bot_present = false`, and a group with `'administrator'` gets `true`.
  - A tip with `refunded_at` set gets `refunded = true`, and one without gets `false` (not null).
- `it('lets the reader role read stats but not the raw tables')`. Inside `begin`/`rollback`, `set local role <reader>`:
  - `select count(*) from stats.users` succeeds.
  - `select count(*) from public.users` rejects with an error matching `/permission denied/`.
- `it('rebuilds the views after a staging reset and the reader can still read them')`:
  - Run `drop schema drizzle cascade; drop schema public cascade; create schema public;` as the test user.
  - Then run `runMigrations(url)` again and repeat both of the previous test's checks.
  - Afterwards the seven views exist again. Default privileges grant `select` again, so no grant needs re-running.

  Work out from `migrate.ts` exactly which statements the reset runs and mirror them; don't call `resetOnMismatch`, which only fires on a mismatch.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @chess-goat/server exec vitest run test/integration/stats-views.test.ts`
Expected: FAIL. The `stats` schema doesn't exist.

- [ ] **Step 3: Generate the migration and write the views**

- Run the `drizzle-kit generate --custom --name stats_views` command from the Files list, then confirm that a `0014_stats_views` entry is in `meta/_journal.json`.
- In `0014_stats_views.sql`, start with a header comment, in the style of 0010's: "Usage dashboard spec: anonymised read-only views for Metabase. A later migration that alters or drops a column one of these views reads must `create or replace` (or drop and recreate) the view in the same migration; Postgres refuses to drop a column a view depends on." Then add `create schema if not exists stats;` and one `create or replace view` per table above, separated by `--> statement-breakpoint`.

- [ ] **Step 4: Run the tests to see them pass**

Run the same command as Step 2.
Expected: PASS. If the reset test fails because the reader lost access, check that the default privileges belong to the role that runs migrations (the test user). Don't add grants to the migration.

- [ ] **Step 5: Write the runbook entry in `docs/operations.md`**

Add a Runbook bullet, **"Set up the usage dashboard's database user"**. It's the one-off SQL to run in the Dokploy PostgreSQL console, connected as the same user the app uses (so `alter default privileges` covers the views future migrations create). The password and database are placeholders:

```sql
create role metabase_reader login password '<generate with: openssl rand -hex 24>';
grant connect on database <database> to metabase_reader;
grant usage on schema stats to metabase_reader;
grant select on all tables in schema stats to metabase_reader;
alter default privileges in schema stats grant select on tables to metabase_reader;
revoke all on schema public from metabase_reader;
```

Also say that the views carry only ids, timestamps and categories. Link to the Metabase section of `deploy-dokploy.md` (written in Task 3). The test in Step 1 must run these same statements, with the role name and the `connect` grant adapted. Keep them in sync.

- [ ] **Step 6: Run the whole server suite and lint**

Run: `pnpm --filter @chess-goat/server test && pnpm lint`
Expected: everything passes. That includes `migrate-reset.test.ts` and the migration tests that copy the journal.

- [ ] **Step 7: Commit**

`git commit -m "Add anonymised stats views for the usage dashboard"` (with the trailer).

---

### Task 3: Metabase setup and the dashboard recipe

**Files:**
- Modify: `docs/deploy-dokploy.md` (new section "Usage dashboard (Metabase)", after "Worth doing before you rely on it")
- Test: none automated. The verification step runs the recipe's SQL against a migrated test database.

**Interfaces:**
- Consumes: the `stats.*` views and their columns from Task 2, and the runbook entry in `docs/operations.md`.

- [ ] **Step 1: Write the setup part**

The section covers, in order:
- **RAM.** Metabase wants 1–2 GB on top of the app. Dokploy runs everything on its own host, so check its free memory first.
- **Template.** Add Dokploy's **Metabase** template to the same project. Keep or pin the image to a `v0.x` tag (`metabase/metabase:v0.63.x`, the free open-source edition). Never use `metabase-enterprise` or a `v1.x` tag. Keep the template's own application database.
- **Domain.** Give it its own hostname with HTTPS. On first boot, create the admin account. In Admin → Settings, turn off anonymous usage tracking.
- **Database user.** Create `metabase_reader` with the runbook SQL in `operations.md`.
- **Data source.** In Admin → Databases, add PostgreSQL:
  - host: the PostgreSQL service's **internal** name (from its Dokploy page; never expose a public port)
  - user: `metabase_reader` and its password
  - schema filter: only `stats`

  Don't paste connection strings anywhere else.

- [ ] **Step 2: Write the dashboard recipe**

One dashboard, **"Chess Goat usage"**, with auto-refresh at 5 minutes. Give each headline number as a short native SQL question against `stats.*`, so it can be rebuilt exactly. Give each graph as a question-builder recipe (table, filter, summarize, group by) or as SQL where a join is needed.

Headline numbers:
- Groups with the bot (`bot_present`); groups that removed it
- Games in progress, human vs human and vs the bot (`status = 'active'`, split on `vs_engine`)
- Games finished (`counted`)
- People seen (all `stats.users`)
- People who have played (`has_played`)
- People active in the last 7 days (`last_seen_at > now() - interval '7 days' and not deleted`)
- Shares: all time, last 24 h, last 7 days
- Moves played
- Challenges pending (`status = 'pending'`)
- Stars received (`sum(stars)` where `not refunded`)

Graphs, by day over the last 90 days:
- Groups added, cumulative
- New people per day, plus cumulative people seen
- Games started per day, split by `vs_engine`
- Shares per day
- Moves per day
- Distinct players per day: games with a move that day, unpivot `white_id`/`black_id`, inner join `stats.users` (which drops the engine), count distinct

Under the graphs, add a short note on what the dashboard can't show (from the spec's "What this does not cover"): removals over time, and a history of "active in the last 7 days".

- [ ] **Step 3: Check that every SQL snippet in the recipe runs**

Run each snippet against a freshly migrated scratch database. The simplest way is a throwaway vitest file in the scratchpad, using `scratchDatabase` and `runMigrations`. It runs each query, and the file is deleted afterwards. Never print the connection URL.
Expected: every query runs without error and returns one row (the numbers) or day-bucketed rows (the graphs).

- [ ] **Step 4: Commit**

(`docs/` is in `.prettierignore`; match the surrounding Markdown by hand.)

`git commit -m "Document the Metabase usage dashboard"` (with the trailer).
