# Deploying on Dokploy

Dokploy runs the repository's `Dockerfile` on your own VPS and puts Traefik in front with a
Let's Encrypt certificate, which is everything this app needs from a host: one HTTPS origin serving
both the API and the Mini App, plus a PostgreSQL 18 database.

Dokploy's UI labels move between versions. The concepts below are stable; take the exact wording
from your install.

## Before you start

- A VPS with Dokploy installed, and a domain whose A record points at it.
- **2 GB of RAM or more.** The image build installs the whole pnpm workspace and runs a Vite build.
  On a 1 GB box it tends to be killed part-way through.
- A bot token from [@BotFather](https://t.me/BotFather) (`/newbot`). You need the token before the
  first deploy, but *not* the Mini App registration, which comes after the domain works.

Dokploy's own dashboard listens on port 3000 of the VPS. So does this container, internally. They do
not collide: Traefik routes to the container by domain, and the container's port is never published
on the host.

## 1. Project and database

Create a project, then add a **PostgreSQL** service to it. Pick version 18 to match what the
migrations are tested against, and set a strong password.

When it is running, open its page and copy the **internal** connection string. It looks like:

```
postgresql://postgres:<password>@<service-name>:5432/<database>
```

Use the internal host, which is the service name on Dokploy's Docker network, not the VPS's public
IP. That string is your `DATABASE_URL`. Do not expose the database on a public port.

## 2. Application

Add an **Application** service to the same project.

- **Source**: your Git provider and this repository, branch `main`.
- **Build Type**: `Dockerfile`, with path `Dockerfile` and build context `.` (the repository root,
  which is where the multi-stage build expects to run).

Nothing else about the build needs changing. The image already sets `PORT=3000`,
`MINI_APP_DIR=/app/apps/miniapp/dist` and a health check against `/healthz`.

## 3. Domain

In the application's **Domains** tab, add your hostname, set the container port to **3000**, and
turn on HTTPS with Let's Encrypt.

Do this before the first deploy. The server registers its Telegram webhook at boot using
`PUBLIC_URL`, so the domain should already resolve and terminate TLS by the time it starts.

## 4. Environment

In the **Environment** tab:

| Variable | Value |
|---|---|
| `BOT_TOKEN` | from BotFather |
| `BOT_USERNAME` | your bot's username, without `@` |
| `MINI_APP_SHORT_NAME` | the short name you will use in step 6 |
| `PUBLIC_URL` | `https://your.domain` — no trailing slash |
| `WEBHOOK_SECRET` | 16 characters or more |
| `SESSION_SECRET` | 32 characters or more |
| `METRICS_TOKEN` | optional; `openssl rand -hex 32` |
| `DATABASE_URL` | the internal string from step 1 |

Generate the secrets rather than inventing them:

```bash
openssl rand -hex 16   # WEBHOOK_SECRET
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # METRICS_TOKEN (optional)
```

The server validates all of this at boot and refuses to start with a message naming the variable at
fault, so a typo shows up immediately in the deploy logs rather than as strange behaviour later.

You do not need `MINI_APP_DIR` or `PORT`; the image sets both. Rotating `SESSION_SECRET` later logs
every open Mini App session out.

## 5. Deploy

Hit Deploy and watch the logs. A good start ends with a line containing `server started`, listing
the port and the roles. Then check from your own machine:

```bash
curl https://your.domain/healthz      # ok
curl https://your.domain/readyz       # ok, meaning the database is reachable
curl -I https://your.domain/app/      # 200, text/html
```

Migrations run automatically at boot under an advisory lock.

**Keep the replica count at 1.** The live board updates go through an in-process event bus, and the
per-user rate limiter is in-process too. A second replica would mean a move made by a player
connected to one instance never reaches a spectator connected to the other. Scaling out needs the
PostgreSQL `LISTEN`/`NOTIFY` bus named in the technical design (§4.3); it is not built yet.

If the webhook failed to register because the domain was not ready on the first attempt, the server
logs it and carries on serving rather than crash-looping. Redeploy once the domain works and it
registers cleanly.

## 6. Register the Mini App

Now that the domain serves `/app/`, go back to BotFather:

- `/newapp`, choose your bot, give it a title, description and image, and set the **Web App URL** to
  `https://your.domain/app/` with the trailing slash.
- The **short name** it asks for last must match the `MINI_APP_SHORT_NAME` you set in step 4. If you
  choose a different one, update the variable and redeploy.
- Optionally set the same URL as the bot's **Main App** (*Bot Settings* → *Configure Mini App*) so the
  bot's profile gets an **Open App** button. It opens the user's games across all groups.
- In the same place, upload [`docs/assets/miniapp-loading-icon.svg`](assets/miniapp-loading-icon.svg)
  as the loading icon Telegram shows while the app starts.

Do not add commands or a menu button in BotFather. On every start the server registers `/challenge`,
`/chess` and `/settings`, and points the DM's **Open** menu button at `<PUBLIC_URL>/app/`.

## 7. Use it

Create a group, add the bot, and promote it to administrator so it can pin its card and see who
joins. Tap **Challenge someone** on the welcome card, send `/challenge @name`, or reply to someone with
`/challenge`. `/chess` posts the Challenge and lobby buttons again.

## Worth doing before you rely on it

**`/metrics` is hidden by default.** It answers 404 unless `METRICS_TOKEN` is set, and then only to
requests carrying `Authorization: Bearer <token>`. Set it if you scrape the endpoint; leave it unset
and nothing is exposed.

**Redact query strings in access logs.** The Mini App passes its session token as `?token=` on the
live-updates stream, and a short-lived scoped token on the PGN download. Telegram's own design
forces this, because an `EventSource` cannot set headers. If Traefik access logs are on, those
tokens land in them.

**Turn on database backups.** Dokploy's PostgreSQL service can run scheduled dumps to S3-compatible
storage. Games, ratings and history all live there, and nothing else is persistent: the container
itself writes nothing to disk, so it needs no volume.

**Set up auto-deploy** from the application's webhook if you want pushes to `main` to ship. CI runs
the full suite on every pull request, and the end-to-end suite plus a Docker image smoke test on
`main`, so a green `main` is a reasonable thing to deploy automatically.

## Usage dashboard (Metabase)

An optional read-only dashboard over anonymised views of the database (`stats.*`). It shows how many groups, people, games, shares and tips there are, and how they grow. It sees ids, timestamps and categories only: no names, usernames, Telegram ids or chat titles.

**Check the RAM first.** Metabase wants 1-2 GB on top of the app, and Dokploy runs everything on its own host. Look at the host's free memory before adding it.

**Add the template.** Add the **Metabase** template, either in this project or in a Dokploy
project of its own (say, "Analytics"). One Metabase can connect to several databases, so a
separate project suits it if other apps will report to it too; the data-source step below works
the same from any project, as long as both services are on Dokploy's shared network. In its compose file, pin the image to an exact release of the free open-source edition,
`metabase/metabase:v0.65.2.5` (the latest on 2026-11-01), not `latest`: an upgrade migrates Metabase's
own database and cannot be rolled back, so upgrade on purpose, by changing the tag after a backup of
that database. What keeps it free is the repository, `metabase/metabase`; never switch to
`metabase/metabase-enterprise`. Keep the template's own application database; Metabase stores its settings there, not in the app's.

**Give it a domain.** Add its own hostname with HTTPS, as in step 3. The page is public, so
Metabase's login is the only lock on it: use a long, generated password for the admin account, and
create no other accounts you don't need. On first boot, create that admin account. Then, in
Admin → Settings, turn off anonymous usage tracking.

Making it private later, without SSH, needs a private network or a login wall in front of it, since
every Dokploy domain is served to the whole internet: Tailscale (`tailscale serve` to a loopback-only
port, reached from your own devices), or Cloudflare Access in front of the hostname.

**Create the database user.** Run the SQL in the "Set up the usage dashboard's database user" entry of [operations.md](operations.md), once. It creates `metabase_reader`, which can read the `stats` views and none of the app's tables.

**Connect the data source.** In Admin → Databases, add a **PostgreSQL** database:

- host: the PostgreSQL service's **internal** name, from its Dokploy page. Never expose a public port for this. If that name doesn't resolve from Metabase, make sure the Metabase service is on Dokploy's shared network (turn off Isolated Deployment for it).
- port and database name: the same as the app's
- user: `metabase_reader`, and its password
- schema filter: only `stats`

Don't paste connection strings anywhere else.

### The dashboard

Make one dashboard, **Chess Goat usage**, and set its auto-refresh to 5 minutes. Each headline number below is a native SQL question (New → SQL query) against the `stats` database, saved as a number card. Each graph is a question-builder recipe, or SQL where it needs a join. Day graphs cover the last 90 days.

**Headline numbers**

Groups with the bot:

```sql
select count(*) from stats.groups where bot_present;
```

Groups that removed it:

```sql
select count(*) from stats.groups where not bot_present;
```

Games in progress, human vs human:

```sql
select count(*) from stats.games where status = 'active' and not vs_engine;
```

Games in progress, vs the bot:

```sql
select count(*) from stats.games where status = 'active' and vs_engine;
```

Games finished:

```sql
select count(*) from stats.games where counted;
```

People seen:

```sql
select count(*) from stats.users;
```

People who have played:

```sql
select count(*) from stats.users where has_played;
```

People active in the last 7 days:

```sql
select count(*) from stats.users
where last_seen_at > now() - interval '7 days' and not deleted;
```

Shares, all time:

```sql
select count(*) from stats.shares;
```

Shares, last 24 hours:

```sql
select count(*) from stats.shares where created_at > now() - interval '24 hours';
```

Shares, last 7 days:

```sql
select count(*) from stats.shares where created_at > now() - interval '7 days';
```

Moves played:

```sql
select count(*) from stats.moves;
```

Challenges pending:

```sql
select count(*) from stats.challenges where status = 'pending';
```

Stars received:

```sql
select coalesce(sum(stars), 0) from stats.tips where not refunded;
```

**Graphs**

Make each a line or bar chart with the day on the x axis.

- **New people per day.** Table `Users`; Summarize → Count by `Created At: Day`; filter `Created At` → Previous 90 days.
- **Games started per day, split by vs engine.** Table `Games`; Summarize → Count by `Started At: Day` and `Vs Engine`; filter `Started At` → Previous 90 days. Show as a stacked bar.
- **Shares per day.** Table `Shares`; Summarize → Count by `Created At: Day`; filter `Created At` → Previous 90 days.
- **Moves per day.** Table `Moves`; Summarize → Count by `Played At: Day`; filter `Played At` → Previous 90 days.
- **Groups added, cumulative** and **People seen, cumulative.** A running total has to start from the all-time count, so these are SQL (below) and cover all time rather than 90 days.
- **Distinct players per day.** This needs a join, so use SQL (below).

Groups added, cumulative:

```sql
select day, sum(added) over (order by day) as groups_total
from (
  select created_at::date as day, count(*) as added
  from stats.groups
  group by 1
) d
order by day;
```

People seen, cumulative:

```sql
select day, sum(added) over (order by day) as people_total
from (
  select created_at::date as day, count(*) as added
  from stats.users
  group by 1
) d
order by day;
```

Distinct players per day. This takes games that had a move that day, unpivots white and black, and joins `stats.users`, which drops the engine:

```sql
with played as (
  select distinct m.played_at::date as day, m.game_id
  from stats.moves m
  where m.played_at > now() - interval '90 days'
)
select p.day, count(distinct u.id) as players
from played p
join stats.games g on g.id = p.game_id
cross join lateral (values (g.white_id), (g.black_id)) as side(user_id)
join stats.users u on u.id = side.user_id
group by p.day
order by p.day;
```

**What the dashboard can't show.** Groups that removed the bot have no removal timestamp, so removals over time aren't graphed; only the current count is. "Active in the last 7 days" exists only as a current number, because nothing stores its history. Put a text card under the graphs saying so, so nobody reads the missing lines as zero.

## A staging environment

A second copy of the app, with a fixed domain, lets you try any branch inside Telegram before it
reaches `main`. It needs its own everything:

- **Its own bot.** Create a second bot in BotFather. Never give staging the production `BOT_TOKEN`:
  the server registers its webhook at boot, so a staging deploy with the production token would
  take production's webhook, and the live bot would stop receiving updates. Register the staging
  bot's Mini App (step 6) against the staging domain.
- **Its own database.** A separate PostgreSQL service, never the production one. Migrations run at
  boot, so a branch with a new migration would apply it to whatever `DATABASE_URL` points at.
- **Its own secrets.** A fresh `WEBHOOK_SECRET` and `SESSION_SECRET`.

**Create the staging services from scratch; do not duplicate the production environment.**
Duplicating copies each PostgreSQL service's volume name, so the staging database mounts
production's data directory. Two PostgreSQL servers then write the same files at once, which
corrupts data, and the staging app serves production's groups. If you did duplicate, check that the
staging PostgreSQL service's volume mount does not name the production one, and
replace any copied variables.

Set it up with steps 1 to 6, using a staging subdomain, and add one more variable:

| Variable | Value |
|---|---|
| `DATABASE_RESET_ON_MISMATCH` | `true` |

**Why the reset.** Drizzle only compares a migration's timestamp with the newest one the database has
applied. On a database that different branches take turns deploying to, that goes wrong three ways.
A migration the next branch lacks stays applied. A branch's migration that is older than the newest
applied one is skipped with no error. And a newer one stacks on a schema no branch actually has.
With the flag on, the server compares the applied migrations with the build's, in order and by
hash. If the database holds exactly the build's migrations or a leading part of them, it keeps its
data and migrates forward as usual. Otherwise it wipes the database, migrates from empty, and logs
a warning saying so. Deploying `main`, then a branch that adds a migration, keeps your test data;
going back to `main` afterwards wipes it.

**Never set `DATABASE_RESET_ON_MISMATCH` in production.** It is off unless set to `true`.

**Choosing what staging runs.** The simplest arrangement is a `staging` branch that you never merge,
with the staging application following it and auto-deploy on. Deploying a branch is then one push:

```bash
git push --force origin my-branch:staging
```

After a reset, the staging groups still hold pinned cards for games that no longer exist. Start new
games rather than using those cards.

## When something is wrong

| Symptom | Cause |
|---|---|
| Build killed part-way | Not enough RAM on the VPS; 2 GB or more |
| Container restarts in a loop | Invalid configuration. The log names the variable |
| `/readyz` fails, `/healthz` passes | `DATABASE_URL` wrong, or the database service is not running |
| Blank screen inside Telegram | The Web App URL in BotFather is missing the trailing slash, or points somewhere other than `/app/` |
| Bot ignores every command | The webhook never registered. Check `PUBLIC_URL` exactly matches the domain, then redeploy |
| Moves work, the opponent's board does not update | More than one replica. Set it back to 1 |
| Group card never updates | The bot is not an administrator in that group |

The metrics to watch and the runbook for day-to-day operation are in
[operations.md](operations.md).
