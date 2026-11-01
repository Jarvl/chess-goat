# Usage dashboard: Metabase over read-only stats views, and a closed `/metrics`

Status: design, 2026-11-01.

## Why

The operator has no view into how Chess Goat is used: how many groups have the bot, how many games are
running, how many people use it, how often positions are shared. Everything needed is already in
Postgres, most of it timestamped, but the only window today is a Prometheus `/metrics` endpoint that
nothing scrapes, whose in-process counters reset on every deploy, and which is publicly readable on the
Dokploy domain (docs/deploy-dokploy.md, "Close off `/metrics`"). The operator treats that last point as
a security problem to fix now, not something to accept.

## Goals

- Graphs and headline numbers the operator can open in a browser, answering first "how big is it right
  now" and second "how has it got here".
- The numbers the operator asked for (all totals across all groups):
  - **Groups:** with the bot now; that have removed it.
  - **Games:** in progress now, split human-vs-human and vs the bot; finished in total.
  - **Users:** seen in total; who have played at least one game; active in the last 7 days.
  - **Shares:** total, in the last 24 hours, in the last 7 days, and shares per day over time.
  - **Also:** moves played, challenges pending, Telegram Stars tips received.
- Only the free, self-hosted, open-source Metabase edition.
- `/metrics` no longer readable by anyone on the internet.

## Non-goals

- Per-group or per-person views. No group titles, names, usernames or Telegram ids reach the dashboard.
- Alerting, uptime or performance monitoring (Prometheus/Grafana territory; untouched).
- Any change to what players see in the bot or the Mini App.
- New event tracking. Everything comes from tables that exist today.

## Anti-goals

- A dashboard login that, if leaked, exposes personal data. The database user Metabase holds must not be
  able to read names, usernames, Telegram ids, photos, DM text or game card ids.
- Any paid Metabase feature or the Enterprise image (`metabase/metabase-enterprise`, versions `v1.x`).
- `/metrics` reachable without a secret.

## Constraints

- Deployed on Dokploy: one app container, one PostgreSQL 18 service, Traefik in front. Dokploy offers a
  Metabase template (checked 2026-11-01: `v0.63.18`, the open-source line).
- Migrations run at boot through drizzle's migrator under an advisory lock (`apps/server/src/db/migrate.ts`).
  On staging, `DATABASE_RESET_ON_MISMATCH` runs `drop schema public cascade`, which also drops views in
  other schemas that depend on public tables.
- Database passwords never go in the repository.
- Metabase cannot export or version its dashboards in the free edition (serialization is paid), so the
  dashboard itself is built by hand in the Metabase UI.

## Approaches

Considered:

1. **Metabase on Dokploy (chosen).** Point-and-click questions over Postgres, dashboards, auto-refresh and
   its own login, no app code for the charts. Costs: a JVM wanting roughly 1–2 GB of RAM, and a login
   separate from Telegram.
2. **Grafana on Dokploy.** Lighter (~100 MB) and strongest at time series, and could scrape `/metrics`
   later; but every panel is hand-written SQL and the tool is built for ops monitoring, not product usage.
3. **Charts in the Mini App behind a Telegram-id allowlist.** Keeps the Telegram login, but every chart is
   repository code and a deploy.

Dropped early: Apache Superset (needs Redis and workers; too heavy for one viewer); a text-only `/stats`
bot command (the operator wants graphs).

The operator picked Metabase, free self-hosted edition only. Earlier in the conversation the operator
offered a Telegram allowlist; with Metabase the allowlist is replaced by Metabase's own accounts, and no
allowlist is built.

## Design

### 1. A `stats` schema of anonymised views (migration)

A new drizzle migration creates schema `stats` and, in it, row-level views that carry only ids,
timestamps and categorical columns. Row-level (rather than pre-aggregated) so Metabase's question builder
can group, filter and bin by day/week freely. Internal numeric ids are kept so views can be joined and
distinct people counted; they are meaningless outside the database.

| View | Columns | Notes |
|---|---|---|
| `stats.users` | `id`, `created_at`, `last_seen_at`, `has_played`, `deleted` | Excludes `is_engine`. Keeps users who deleted their data (the row is already scrubbed), flagged `deleted = deleted_at is not null`, so totals never shrink after the fact and agree with games and shares, which keep counting those people. `has_played`: appears as white or black in any game. *(Builder-check call.)* |
| `stats.groups` | `id`, `created_at`, `type`, `is_forum`, `bot_present` | `bot_present = bot_status <> 'left'`. |
| `stats.games` | `id`, `group_id`, `white_id`, `black_id`, `started_at`, `finished_at`, `last_move_at`, `status`, `end_reason`, `rated`, `vs_engine`, `ply_count`, `voided`, `counted` | `vs_engine`: either side is the engine user. `voided = voided_at is not null`. `counted`: finished, not voided, and `end_reason` not `abort`/`timeout_abort` (games that never really started). `white_id`/`black_id` are internal ids, needed for distinct players. *(Builder-check call.)* |
| `stats.moves` | `game_id`, `ply`, `played_at` | No move text. |
| `stats.shares` | `id`, `game_id`, `user_id`, `created_at` | |
| `stats.challenges` | `id`, `group_id`, `created_at`, `resolved_at`, `status`, `rated` | |
| `stats.tips` | `id`, `paid_at`, `stars`, `refunded` | No payer, no charge id. |

The views are owned by the app's database user and are not `security_invoker`, so a reader granted
`SELECT` on the views needs no rights on the underlying tables.

The migration creates the schema with `create schema if not exists stats` and the views with
`create or replace view`, so a staging reset (which drops dependent views but leaves an empty `stats`
schema) re-applies cleanly.

Later migrations that alter a column a view reads must recreate the affected view; the migration file
carries a comment saying so.

### 2. A read-only database user for Metabase (manual, documented)

Not in a migration, because it needs a password. `docs/operations.md` gets a one-off SQL block the
operator runs once in the Dokploy PostgreSQL console:

```sql
create role metabase_reader login password '<generated>';
grant connect on database <db> to metabase_reader;
grant usage on schema stats to metabase_reader;
grant select on all tables in schema stats to metabase_reader;
alter default privileges in schema stats grant select on tables to metabase_reader;
revoke all on schema public from metabase_reader;
```

The `alter default privileges` line is issued as the app's database user, so views a later migration adds
are readable without re-running grants. (Builder: verify `create or replace view` keeps existing grants,
which Postgres does, and that a staging reset's drop-and-recreate is covered by the default privileges.)

### 3. Metabase on Dokploy (manual, documented)

A new section in `docs/deploy-dokploy.md`:

- Add Dokploy's Metabase template to the same project, pinned to a `v0.x` tag (open-source edition), with
  its own application database as the template provides. Not the Enterprise image.
- Not publicly accessible (operator decision): no domain; its port is published on the host's loopback
  only and reached through an SSH tunnel. Metabase's login is a second layer; create one admin account on
  first boot, and turn off anything that sends data out (anonymous usage tracking) in Admin settings.
- Add the chess-goat database as a data source using the **internal** host, user `metabase_reader`, and
  restrict Metabase to the `stats` schema.
- Note the RAM requirement (Metabase wants 1–2 GB on top of the app; the existing guide asks for 2 GB for
  the app build). Dokploy runs everything on its own host (no remote servers registered), so check that
  host's free memory before adding Metabase; resize it if needed.

### 4. The dashboard recipe (documented)

Because free Metabase cannot import dashboards, the docs list each card with its definition so it can be
rebuilt. One dashboard, "Chess Goat usage", headline numbers on top and graphs below:

Headline numbers (Metabase "Number" cards):
- Groups with the bot; groups that removed it.
- Games in progress (human vs human / vs bot); games finished (`counted`: excludes voided and aborted).
- People seen (including those who later deleted their data); people who have played; people active in the last 7 days (`last_seen_at`, excluding `deleted`).
- Shares: all time, last 24 h, last 7 days.
- Moves played; challenges pending; Stars received (excluding refunded).

Graphs (by day, last 90 days by default):
- Cumulative groups with the bot (from `stats.groups.created_at`; removals have no timestamp, so this is
  groups ever added; the "removed" number sits beside it).
- New people per day and cumulative people seen.
- Games started per day, split by `vs_engine`.
- Shares per day.
- Moves per day.
- Distinct players per day: distinct `white_id`/`black_id` of games with a move that day (via `stats.moves`
  joined to `stats.games`), excluding the engine user (join to `stats.users`, which omits it). This is the historical stand-in for "active people", since `last_seen_at`
  only holds the latest visit.

Auto-refresh every few minutes is a dashboard setting; no caching configuration needed at this scale.

### 5. `/metrics` behind a token (app code)

- New optional config `METRICS_TOKEN` (min 32 chars) in `apps/server/src/config.ts`.
- Unset: `GET /metrics` returns 404, as if the route did not exist. This is the new default, so every
  deployment is closed without action.
- Set: the request must carry `Authorization: Bearer <METRICS_TOKEN>` (constant-time comparison);
  otherwise 404 as well, so the endpoint's existence is not revealed.
- Counters keep counting in-process either way; only the HTTP exposure changes.
- Tests: unset → 404; wrong/missing token → 404; right token → 200 with Prometheus content type.
- Docs: replace the "Close off `/metrics`" paragraph in `docs/deploy-dokploy.md` and update the
  `/metrics` line in `docs/operations.md`; add `METRICS_TOKEN` to `.env.example` and the env table.

## What this does not cover

- Groups that removed the bot have no removal timestamp (only `updated_at`, which other changes touch), so
  removals over time are not graphed.
- "Active in the last 7 days" exists only as a current number; there is no stored history of it.

## Calls made after the builder check

Marked *(Builder-check call)* above: deleted users stay in the counts with a flag; `stats.games` carries
`white_id`/`black_id` for distinct players, engine excluded; "games finished" excludes voided and aborted
games via a `counted` flag.

## Left to the builder

- Exact view SQL and the migration's name; whether `has_played` is a correlated subquery or a join.
- Test for the views: a migration test that the views exist and that the stats views expose no column
  named like a personal field (e.g. a check against a forbidden-column list), plus a check that a role
  with only the documented grants can select from `stats` and is refused on `public.users`.
- Where in the Hono app the `/metrics` guard lives.
