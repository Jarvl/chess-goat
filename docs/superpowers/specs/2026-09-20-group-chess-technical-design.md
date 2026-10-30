# Group Chess — Technical Design Requirements

| | |
|---|---|
| **Scope** | Technical design for the product in [docs/PRD.md](../../PRD.md) (Draft v0.2, 2026-09-20) |
| **Status** | Draft v0.2, for review |
| **Date** | 2026-09-20 |
| **Method** | superpowers `brainstorming` skill, architectural path (see §0) |
| **Next step** | After review, an implementation plan at `docs/superpowers/plans/2026-09-20-group-chess.md` (superpowers `writing-plans`) |

---

## 0. How to read this document

This design follows the superpowers brainstorming skill's architectural path: explore the project, ask clarifying questions, propose two or three approaches per decision, present the design, write the spec, self-review it. The session that produced it was unattended, so the questions the skill asks one at a time could not be put to anyone. Each of them is answered in §1 instead, with the reasoning and the cost of reversing the answer. **Review §1 first**; everything else follows from it.

Library and platform facts were re-verified on 2026-09-20 (Appendix A). A fact that could not be verified from the build sandbox is marked *verify in spike* and collected in §17.

Conventions: "must" is a requirement for the alpha, "should" is a strong default, "P1" follows the PRD's priorities. Identifiers in examples are illustrative.

Revisions: v0.2 adds §3.6 and decision D13, the reasoning behind the bot, HTTP and database libraries, after review.

## 1. Decisions taken on your behalf

| # | Question the brainstorm would have asked | Decision | Why | Cost to reverse |
|---|---|---|---|---|
| D1 | Which language and runtime? | TypeScript end to end: Node 22 LTS server, TypeScript Mini App, one shared package | The Mini App must be TypeScript anyway. One rules engine (chess.js) on both sides gives identical legal-move sets. One toolchain suits a small team | High once code exists. Alternative B in §3.1 |
| D2 | Which board library, and is a GPL dependency acceptable? | chessground 9.x; the repository is licensed GPL-3.0-or-later | The repository is already public. chessground is the only candidate with touch drag proven at Lichess scale, has no framework dependency and weighs 10 KB | Medium: the board sits behind an adapter (§6.3). Swapping to react-chessboard (MIT) costs the adapter plus React |
| D3 | UI framework for the Mini App? | Preact 10 + Vite | 4 KB, React-compatible, protects the 2 s load budget | Low before UI work starts |
| D4 | Service topology? | One deployable with four roles in one process; PostgreSQL 16 is the only stateful dependency | v1 load is tiny (§13). One process removes a broker, Redis and cross-service consistency problems | Low: roles split by environment variable; the event bus has a Postgres NOTIFY upgrade path |
| D5 | Live-update transport? | Server-Sent Events (SSE) for server→client, HTTP POST for actions | One-directional needs, built-in reconnect, trivial to proxy | Low: one client module, one server route |
| D6 | Rules engine? | chess.js 1.4 plus an in-house arbiter for fivefold repetition, the 75-move rule and claim logic | chess.js is BSD and verified correct on repetition and draw detection (Appendix A) but lacks two automatic-draw rules | Low |
| D7 | Rating implementation? | In-house Glicko-2 with per-game rating periods and time-based deviation inflation; voiding a game triggers a full recompute for the group | The algorithm is about 150 lines, must be tested against the published worked example, and needs custom inactivity and void handling either way | Low |
| D8 | Hosting? | One container on a managed platform plus managed PostgreSQL with daily snapshots; provider left open | Nothing in the design depends on the provider | None |
| D9 | Lichess integration? | Server-side `POST /api/import` with an app OAuth token, queued; an instant fallback link to the Lichess analysis board carrying the full PGN | Import volume is far below the limits; the fallback needs no server round trip | Low |
| D10 | Does the bot need admin rights? | Recommended, not required. Authorization uses a verification ladder (§5.6) | `getChatMember` is only guaranteed to work when the bot is an administrator (Bot API 10.3) | None |
| D11 | Board images for shared positions? | Server-rendered SVG rasterised to PNG with resvg; cache keyed to the Telegram `file_id` | Deterministic, no headless browser | Low |
| D12 | Mini App authentication? | Validate `initData` once per launch, issue a 24 h session token | Standard recipe; avoids re-validating every request and handles apps left open for hours | Low |
| D13 | Which libraries inside the TypeScript stack? | grammY for the bot, Hono for HTTP, Drizzle for PostgreSQL | grammY tracks the Bot API within days and has maintained throttling plugins; Hono gives typed routes, a zod validator and an SSE helper; Drizzle expresses skip-locked reads and partial indexes in a TypeScript schema (§3.6) | Low: Telegraf, Fastify and Kysely fit the same seams |

## 2. Scope

**In scope.** Everything marked P0 in PRD §7. P1 items only where they constrain the schema or API today: the board theme and piece set preference fields, and nothing else (share-to-any-chat uses Telegram's `savePreparedInlineMessage` and needs no schema change).

**Out of scope.** The PRD §3 non-goals: engines, puzzles, tournaments, variants, takebacks, predictions, pre-game analysis, chat move pickers, blitz clocks.

**Deliberately not built (YAGNI).**

- No event log for games. The move list is the log; an SSE reconnect gets a snapshot.
- No Redis, message broker or separate worker deployment at v1.
- No per-second clock ticks from the server, no in-app chat. (Premoves were added on 2026-09-24, and replaced by conditional premoves on 2026-10-29; see the [conditional premoves spec](./2026-10-29-conditional-premoves-design.md).)
- No cross-group rating. Ratings are keyed by group; a cross-group projection can be added later without touching game data.
- No group-mention fallback for users who declined DMs (PRD open question 3). Nothing here blocks it.
- No admin web console. Admin actions live in the Mini App.

## 3. Approaches considered

### 3.1 Stack

| | A. TypeScript end to end (recommended) | B. Python server + TypeScript app | C. Go server + TypeScript app |
|---|---|---|---|
| Server | Node 22, grammY, Hono, Drizzle, PostgreSQL | aiogram 3, FastAPI, python-chess, PostgreSQL | telebot or go-telegram, notnil/chess |
| Rules | chess.js on client and server, arbiter adds fivefold and 75-move | python-chess has every rule and SVG rendering built in | Rule coverage less complete; would need verification |
| Sharing code | Shared DTO types and start-payload codec, same legal-move generator on both sides | Two rules engines and two type systems to keep in sync | Same as B |
| Operations | One toolchain, one CI pipeline, one container | Two toolchains | Two toolchains |
| Choose when | Small team, web-first | Team is Python-native and values python-chess | Team is Go-native |

A wins on a single language and a single rules engine. B's real advantage is python-chess; it costs about 200 lines of arbiter and SVG code to match in A. The libraries inside A are compared in §3.6.

### 3.2 Board library

| | chessground 9.2 (recommended) | react-chessboard 5.12 |
|---|---|---|
| Licence | GPL-3.0-or-later | MIT |
| Dependencies | None, 10 KB gzipped | React 19 and dnd-kit |
| Touch drag | Built for Lichess mobile web | Supported via dnd-kit |
| Legal-move dots, last move, check, promotion hooks | Built in (`dests`, `lastMove`, `check`) | Left to the integrator |
| Consequence | Repository becomes GPL-3.0-or-later | Keeps a permissive licence |

The PRD's alpha exit criterion is drag reliability on iOS and Android; chessground has the strongest evidence there. Because the repository is public, GPL costs nothing today. If a permissive licence becomes a requirement, the board adapter in §6.3 is the seam.

### 3.3 Live updates

| | SSE (recommended) | WebSocket | Polling |
|---|---|---|---|
| Direction | Server→client; actions over POST | Both | Client pulls |
| Reconnect | Built into `EventSource`, `Last-Event-ID` | Hand-written | n/a |
| Proxies and load balancers | Plain HTTP; needs buffering off | Needs upgrade support | Plain HTTP |
| Fit for 2 s p95 | Yes | Yes | Needs ≤1 s polls, wasteful |

### 3.4 Clock enforcement

| | Deadline column + scanner (recommended) | One scheduled job per turn | In-memory timers |
|---|---|---|---|
| Survives restart | Yes, state is the row | Yes, more rows and churn | No |
| Exactness | Decided by comparing the row's deadline with database time inside the move transaction; the scanner only notices | Same, plus job bookkeeping | Drift, loss on restart |
| Detection latency | ≤ scan interval (5 s) | ≤ worker poll | Immediate |

The outcome of a race between a late move and a timeout is decided by the database, not by who noticed first (§7.4).

### 3.5 Voiding a rated game

| | Full group recompute (recommended) | Reverse the delta | Only allow voiding the latest game |
|---|---|---|---|
| Correct for games played after the voided one | Yes | No, later games used the wrong inputs | Yes by construction |
| Cost | O(rated games in group); a large club is a few thousand games, well under a second | O(1) | Limits admins |

### 3.6 Libraries inside the TypeScript stack

These three picks were defaults in v0.1; the reasoning below was added after review. None of them is load-bearing: the `bot` module only translates updates into domain calls, outbound pacing lives in the `telegram` module, the HTTP surface is about 25 routes, and the data layer is thin. Each is a low-cost swap.

**Bot framework: grammY over Telegraf.** Both are MIT and written in TypeScript. The deciding factor is how closely each tracks the Bot API (verified 2026-09-20, Appendix A).

| | Telegraf 4.16.3 | grammY 1.46.0 |
|---|---|---|
| Bot API version the README declares | 7.1 (February 2024) | 10.3 (current, August 2026) |
| Types dependency | `@telegraf/types ^7.1` | `@grammyjs/types 5.0.0`, published the day after Bot API 10.3 |
| Latest release | 4.16.3 | 1.46.0, August 2026 |
| 429 retry and outbound throttling | Community packages, last published 2022 | Official `auto-retry` and `transformer-throttler` plugins, updated 2025 |
| Webhook integration | One Node request handler, usable with Express | Named adapters for Hono, Fastify, Express and others |

Everything P0 in this design uses Bot API methods older than 7.1, so Telegraf would work today. The gap matters for typed access to newer fields, for `savePreparedInlineMessage` (Bot API 8.0, P1) and for whatever Telegram adds next. Telegraf's larger body of tutorials is a fair reason to pick it for a team that already knows it. How the plugins are used here: the `telegram` module applies `transformer-throttler`, which implements Telegram's published per-second, per-chat and per-group limits, as the pacing layer of §5.8; `auto-retry` is not used, because waiting out a long `retry_after` inside a handler would hold a job lease, so the worker reschedules the job instead (§10).

**HTTP framework: Hono over Fastify and Express.** Any of the three carries this load. Hono was chosen for typed routes with a zod validator middleware that reuses the shared schemas unchanged, a built-in SSE streaming helper for the route in §6.4, an official grammY webhook adapter, and a small footprint on Node through its Node server adapter. Fastify is the conservative alternative: JSON Schema validation, the most mature Node plugin set (rate limiting, static files, security headers, back-pressure) and the best raw throughput on Node; SSE needs a plugin or writing to the raw response. Express 5 works but has no typed routing or validation story. A team that already runs Fastify should choose it; only the route files change.

**Database access: Drizzle over Kysely and Prisma.** §7.4 and §10 need `FOR UPDATE`, `FOR UPDATE SKIP LOCKED`, partial indexes, advisory locks, jsonb columns and database `now()`, and §4.3 needs `LISTEN/NOTIFY` later. Drizzle expresses all of these: the schema is TypeScript, drizzle-kit generates migrations from it including partial indexes, skip-locked selects are native, and `sql` templates cover the rest, over the `postgres` driver. Kysely is the equal alternative, a typed query builder with the same locking support, hand-written migrations and types generated from the database; choose it if you prefer SQL migrations. Prisma is not recommended here: skip-locked reads need raw queries and partial indexes need hand-edited migrations, which removes most of what Prisma offers.

## 4. System architecture

### 4.1 Context

```
 Telegram clients (iOS, Android, Desktop, Web)
   │  group chat: cards and images         │  Mini App WebView
   │  (Bot API messages)                   │  HTTPS JSON + SSE
   ▼                                       ▼
 Telegram Bot API ── webhook POST ──▶ ┌──────────────────────────────────────┐
                 ◀── sendMessage,     │ group-chess server (one Node process)│
                     editMessageText, │  roles: bot · api · jobs · clock     │──▶ PostgreSQL 16
                     sendPhoto ────── │  serves the Mini App static bundle   │──▶ Lichess POST /api/import
                                      └──────────────────────────────────────┘
```

### 4.2 Components

Repository layout is in §16. The server is one package with these modules. Dependencies point one way: `bot` and `api` call `domain`, `domain` calls `db`, `telegram`, `images`, `lichess` and `bus`; nothing depends on `bot` or `api`.

| Module | Responsibility |
|---|---|
| `bot` | grammY handlers for `/challenge`, `/chess`, `/settings`, `/start`, callback queries, `my_chat_member`, `chat_member`, service messages. Translates updates into domain calls. Never sends messages directly; it enqueues jobs |
| `api` | Hono routes for the Mini App (§9): launch, lobby, games, moves, SSE, sharing, preferences, admin |
| `domain` | `challenges`, `games` (with the arbiter from the shared package), `ratings`, `sharing`, `notifications`, `membership`. All business rules and transactions live here |
| `telegram` | Outbound Bot API client (grammY `Api` with the `transformer-throttler` plugin for pacing; 429s reschedule the job), card renderer (state → text and keyboard), mention formatting, deep-link builder |
| `jobs` | Outbox worker: leases jobs from the `jobs` table and runs the handler for each kind (§10) |
| `clock` | Scanners for game deadlines, reminders and challenge expiry (§7.3) |
| `lichess` | Import client with global serialisation and 429 handling |
| `images` | SVG board assembler and PNG rasteriser, `file_id` cache |
| `bus` | In-process publish/subscribe of game state changes to SSE streams. Interface with a `LocalBus` implementation; `PgNotifyBus` is the documented upgrade for more than one replica |
| `db` | Drizzle schema, migrations, typed queries |

The Mini App (`apps/miniapp`) has: `tg` (typed wrapper over `telegram-web-app.js` with version gating), `api` (fetch client, SSE client), `board` (chessground adapter), `routes` (lobby, game, replay, new game, players, settings, groups), `i18n`.

The shared package (`packages/shared`) has: `arbiter` (rules on top of chess.js), `pgn`, `glicko2`, `protocol` (zod schemas for every DTO, error codes, start-payload codec, callback-data codec).

### 4.3 Process model

One process runs all four roles by default. `ROLES=api,bot,jobs,clock` selects a subset for a split deployment. Constraints that keep the split possible:

- `bot` and `api` never hold state between requests except caches with TTLs.
- Every outbound Telegram message and every Lichess call is a job, so only the `jobs` role sends anything. Two exceptions are synchronous and read-only or mandatory: `answerCallbackQuery`, which must be answered inline within the update, and the cached membership lookups `getChatMember` and `getChatAdministrators` made by the `api` and `bot` roles (§5.6).
- Game state changes are published to the bus after commit; SSE streams subscribe to the bus. With more than one `api` replica, switch to `PgNotifyBus` (Postgres `LISTEN/NOTIFY` with the game id as payload; subscribers refetch the state). No other change is needed.
- Scanners and the job worker use `SELECT … FOR UPDATE SKIP LOCKED`, so several instances can run them concurrently.

### 4.4 Environments, configuration, deployment

| Environment | Bot | Updates | Mini App origin |
|---|---|---|---|
| dev | Personal dev bot | Long polling (grammY), no public URL needed for the bot | Vite dev server behind a tunnel such as cloudflared, because Telegram must load the app over public HTTPS |
| staging | Staging bot | Webhook | Staging domain |
| prod | Production bot | Webhook | Production domain |

Configuration is environment variables only, validated at startup with zod: `BOT_TOKEN`, `BOT_USERNAME`, `MINI_APP_SHORT_NAME`, `PUBLIC_URL`, `WEBHOOK_SECRET`, `DATABASE_URL`, `SESSION_SECRET`, `LICHESS_TOKEN` (optional), `ROLES`, `LOG_LEVEL`. No secrets in the repository.

Deployment is a multi-stage Docker image: build the Mini App, copy the bundle into the server image, serve it under `/app/` with immutable cache headers for hashed assets and `no-store` for `index.html`. Migrations run on startup under an advisory lock. Rolling restarts are safe because clocks and jobs are table-backed and SSE clients reconnect.

## 5. Telegram integration

### 5.1 Bot configuration checklist (BotFather)

1. Privacy mode on (default).
2. Create the Mini App with `/newapp`, short name `MINI_APP_SHORT_NAME`, URL `PUBLIC_URL/app/`. Enable the same URL as the Main Mini App so the bot profile opens the lobby.
3. Commands via `setMyCommands`: scope `all_group_chats` → `/challenge`, `/chess`, `/settings`; scope `all_private_chats` → `/start`. No default-scope commands, so the group menu stays at three entries.
4. `setWebhook` with `secret_token` and `allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"]`. `chat_member` is not delivered by default and only arrives where the bot is an administrator; it is a bonus feed for the known-players list, never a dependency.
5. Menu button left as the default (opens the Main Mini App).

### 5.2 Update handling

- The webhook route checks the `X-Telegram-Bot-Api-Secret-Token` header and rejects everything else with 401.
- Idempotency: the handler inserts `update_id` into `telegram_updates` inside the same transaction as its effects; a duplicate key means the update was already processed and is acknowledged with 200. Rows older than 7 days are pruned.
- Budget: a handler must finish in under 1 s. It writes to the database and enqueues jobs; it never waits on Telegram, except `answerCallbackQuery`.
- Failures throw, the route returns 500, Telegram retries. Because effects are transactional and idempotent, retries are safe.
- Message text is never logged or stored. Only the fields needed for a command are read (`from`, `chat`, `message_id`, `message_thread_id`, `reply_to_message.from`, entities for the command).

### 5.3 Deep links and payloads

Direct link: `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=<payload>`. The payload must match `^[A-Za-z0-9_-]{1,512}$` and arrives in `initData.start_param`.

| Payload | Opens |
|---|---|
| `g_<gameId>` | Game (live board, replay if finished) |
| `l_<groupId>` | Lobby for that group |
| `n_<groupId>` | New game for that group, landed over its lobby so Back returns there before closing |
| `s_<groupId>` | Group settings (admins) |
| *(none, profile launch)* | The user's groups, then the lobby |

Public ids (`gameId`, `groupId`, `challengeId`) are 10-character base62 strings from a CSPRNG, unique-indexed, never the database primary key or a Telegram chat id. Nothing about a group is inferable from a link.

Callback data (64-byte limit): `ch/acc/<challengeId>`, `ch/dec/<challengeId>`, `gm/rem/<gameId>`. Everything else on a card is a URL button.

### 5.4 Group messages

Every card is rendered by a pure function `renderCard(state) → { text, entities, reply_markup }` from the current database state at send time. The function is snapshot-tested.

| Card state | Text (first line, second line) | Buttons |
|---|---|---|
| Challenge, direct | `♟ Alice challenges Bob` · `1 day per move · Rated · Alice plays White` (colour line only when chosen) | `Accept` `Decline` |
| Challenge, open | `♟ Alice is looking for a game` · `1 day per move · Rated` | `Accept` `Cancel` |
| Declined / cancelled / expired | `♟ Alice vs Bob · Declined` (or `Challenge withdrawn`, `Challenge expired`) | none |
| Running | `♟ Alice (1520) vs Bob (1498)` · `1 day per move · Rated · Move 12 · Bob to move` | `♟ Open game` |
| Finished | `♟ Alice (1520 → 1534) vs Bob (1498 → 1484)` · `Checkmate · 1-0 · 34 moves · 1 day per move` | `🔁 Rematch` `🔍 Analyse on Lichess` |
| Aborted | `♟ Alice vs Bob · Aborted` · reason (`no move within 1 day`) | `🔁 Rematch` |
| Voided | `♟ Alice vs Bob · Voided by an admin` · original result | `🔍 Analyse on Lichess` when the game had moves |
| Shared position | photo, caption `Carol shared move 23 · Alice vs Bob · Black to move` | `♟ Open game` |
| Welcome | `Play chess with this group on a real board inside Telegram. The chat only sees results and shared positions.` | `♟ Open Chess` |

Rules for cards:

- Everyone is named by their Telegram handle (`@alice`), in cards, DMs, one-line replies, the Mini App and the PGN alike (PRD §7.12 stores the username as the display field). A user who has no username falls back to their `first_name`, and an anonymised user reads `Deleted player`; the names in the table above stand for whichever of the three applies.
- The challenged player is mentioned once, on the challenge card: `@username` when they have one, otherwise a `text_mention` entity, which Telegram guarantees to work for members of the group where it is used. `Rated` reads `Casual` for unrated games. Provisional ratings carry a `?` suffix.
- Edits go through an `edit_card` job with dedup key `card:g:<gameId>` (`card:ch:<challengeId>` before the game exists). Re-enqueueing an existing pending job only moves its `run_at`, so bursts collapse into one edit rendered from the latest state. An edit that runs before the card has a `message_id` retries with backoff. This satisfies "at most one status edit per move" and keeps ordering trivial. A minimum spacing of 2 s per card applies.
- "Message is not modified" from Telegram is success. "Message to edit not found" marks the card as gone; the game continues without a card.
- The `Analyse on Lichess` button first carries the fallback URL (§7.6) and is swapped for the imported game URL by one more silent edit when the import lands.
- `♟ Open game` appears on running cards and on shared positions. Finished cards carry exactly the two buttons the PRD specifies; the replay is reached from the lobby's Finished tab or from a shared position's `♟ Open game`.
- The welcome card is pinned only when `my_chat_member` shows the bot is an administrator with `can_pin_messages`; otherwise it is left for a human to pin. The card does not ask admins to promote the bot: whether promotion is needed for membership checks to be authoritative is still open until spike S4 characterises `getChatMember` for a non-admin bot (§5.6).

### 5.5 Commands

| Command | Behaviour | One-line replies (the only case the bot replies to a command) |
|---|---|---|
| `/challenge @name` | Direct challenge to a current member the bot has seen here (handles compare without case), or to the person picked from Telegram's mention list (`text_mention`). A mention wins over a reply | Mentioning the bot or yourself; "I haven't seen @name in this group yet", since the Bot API cannot look a user up by username; limits as below |
| `/challenge` as a reply | Direct challenge to the author of the replied-to message using group defaults. Card posted in the same topic (or the fixed topic, per settings) | Reply to yourself; reply to a bot; reply to an anonymous admin or channel post (`sender_chat` set); opponent or you blocked; you have 3 pending challenges |
| `/challenge` alone | Open challenge, if the group allows them | Open challenges are off in this group; limits as above |
| `/chess` | Posts `⚔️ Challenge someone` (`n_<groupId>`) and `♟ Group lobby` (`l_<groupId>`) URL buttons, one per row. Rate-limited to 20 per person per group per minute; excess is ignored silently | none |
| `/settings` | Posts an `Open settings` URL button (`s_<groupId>`). Same rate limit. Anyone can see the button; the app enforces admin rights | none |
| `/start` in a private chat | Marks `dm_allowed = true` (the user started the chat), replies with an `♟ Open Chess` button. In private chats this may be a `web_app` inline button | none |
| Anything else | Ignored, including commands addressed to other bots and `/challenge@otherbot` | none |

Commands with the bot's suffix (`/challenge@GroupChessBot`) are accepted. Every command from a group also updates `group_members` for the sender (§5.6).

### 5.6 Membership and admin verification

Bot API 10.3 states that `getChatMember` is only guaranteed for other users when the bot is an administrator. The ladder below keeps the product working without admin rights and makes it airtight with them.

Membership check for user U in group G (needed before showing anything group-scoped):

1. Players of a game are always allowed to open that game, regardless of current membership.
2. A cached verdict in `group_members` younger than 10 minutes is used as is.
3. If the bot is an administrator in G: `getChatMember`; `member`, `administrator`, `creator`, or `restricted` with `is_member = true` means member. Cached 10 minutes.
4. Otherwise call `getChatMember` anyway; if it answers, trust it. If it fails, fall back to `group_members.status = 'member'` populated from the user's own activity in G: commands, callback taps on the bot's cards, `new_chat_members` and `left_chat_member` service messages, and `chat_member` updates when available.
5. No evidence means no access: the app shows the group as locked with the sentence "Open a game card in the group once, or ask an admin to promote the bot", which is a Mini App screen, not a group message.

Admin check: `getChatAdministrators` for G (works without admin rights), cached 60 seconds, invalidated when a settings request fails authorization. Applied on every settings read and write and on every void or block, as the PRD requires.

The known-players list for the opponent picker is `group_members` with `status = 'member'`, ordered by `last_seen_at`. *Verify in spike S4:* how `getChatMember` behaves for a non-admin bot in a supergroup for users who have never interacted.

### 5.7 Direct messages and write access

- `dm_allowed` becomes true on `/start` in private, on the `write_access_allowed` service message (delivered in the private chat when the user accepts the Mini App's `requestWriteAccess()` prompt) and when the app reports the prompt result. It becomes false on a 403 "bot was blocked by the user" or "user is deactivated" when sending.
- The app asks once, on first launch. The answer and the fact that it was asked are stored on the user (`dm_allowed`, `write_access_asked_at`); the app never asks again unless the user turns notifications on in settings.
- Turn DM: `Your move vs Alice · 12. Nf3 · 23 h left` with `♟ Open game` (direct link) and `Go to group`. `Go to group` is `https://t.me/c/<supergroup id without the -100 prefix>/<card message id>` and is omitted for basic groups, which have no message links.
- Challenge DM: `Alice challenges you · 1 day per move · Rated` with `♟ Open` (direct link to the lobby, where Accept and Decline are also available).
- Reminder DM: once per turn, when 10 % of the time control remains, only for controls of 8 h or more, only when the player has not moved since the turn started (§7.3).
- No game-end DM. When a human game ends by anything but an abort (`abort`, `timeout_abort`), the group gets one result photo in the game's topic instead: the share card of the final position, drawn from the winner's side (White's for a draw or void), captioned `{white} vs {black} · {result} · {endReason}` plus a rating-change line when rated; buttons `♟ Open game` and `🔍 Analyze on Lichess`. Engine games post nothing at game end. The job is `send_result_photo` (dedup `result:g:<id>`), guarded by `games.result_message_id`.

### 5.8 Group lifecycle, forums, limits

- `my_chat_member`: bot added as member or administrator → upsert the group, post the welcome card, pin if allowed. Bot removed or kicked → `bot_status = 'left'`, pending challenges cancelled, no more group posts; active games continue in the app (players reach them from DMs or the profile launch) and cards are simply not edited. Re-adding the bot posts a fresh welcome card.
- Group to supergroup migration: the `migrate_to_chat_id` service message updates `groups.telegram_chat_id`; the internal id and all games are unchanged.
- Forum groups: `is_forum` is read from the chat object. Cards and shared positions carry `message_thread_id` of the topic where the challenge was made (`origin`, default) or of the configured fixed topic. Messages in the General topic omit `message_thread_id` (*verify in spike S4*). The game stores its thread id so later edits and shares land in the same topic.
- Outbound pacing in the job worker: at most 25 messages per second overall, 1 per second per chat, 18 per minute per group, and `retry_after` from 429 responses is honoured before any further call to that chat. Shared positions are additionally limited to 20 per user per minute by the domain layer, so a user can share several positions at once.

## 6. Mini App

### 6.1 Launch sequence

1. `index.html` loads `https://telegram.org/js/telegram-web-app.js` synchronously first (Telegram's requirement), then the hashed app bundle.
2. On start: `ready()`, `expand()`, apply `themeParams` and `colorScheme`, `disableVerticalSwipes()` when `isVersionAtLeast('7.7')`. Fullscreen (`requestFullscreen`, 8.0) is not used at launch; `expand()` gives a full-height sheet and keeps Telegram's own chrome. Revisit after spike S1 if the board needs the extra height.
3. One request, `POST /api/launch` with `initData` and `start_param`, returns the session token, the user, their preferences, the resolved route and that route's initial data (game state or lobby). One round trip from launch to a painted board.
4. If the launch response says the write-access prompt has never been shown, call `requestWriteAccess()` after the first screen has rendered, then `PUT /api/me/prefs` with the result.
5. Navigation is a bottom tab bar (Games, Groups, Settings), each tab keeping its own stack; `BackButton` carries depth only and closes from the root of a launch that came from a chat link. See [the navigation spec](./2026-09-22-miniapp-tab-navigation.md), which supersedes this step.
6. Every subsequent request carries `Authorization: Bearer <session token>`. A 401 re-runs step 3 with the original `initData`; if that is now older than the 24 h window the app shows one screen, "Reopen from Telegram".

### 6.2 Routes and screens

| Route | Data | Actions |
|---|---|---|
| Games — home (profile launch, no payload) | `GET /api/me/games`, prefetched by `/launch` | Open any of your active games, across groups |
| Groups | `GET /api/me/groups` | Pick a group → lobby |
| Lobby `l_<groupId>` | `GET /api/groups/:g` (Active with "your move" first, Finished page 1, Players, pending challenges, admin flag) | New game, Accept or Decline pending challenges, open any game, Players tab, Settings if admin |
| New game | `GET /api/groups/:g/players` | Pick opponent or Open challenge, time per move, colour, rated → `POST /api/groups/:g/challenges` |
| Game `g_<gameId>` (active) | `GET /api/games/:id` + SSE | Move, Draw offer, Accept or Decline draw, Claim draw, Resign (with confirmation), Abort while allowed, Share position, Flip (spectators), view earlier positions |
| Game end (same route, `status = finished`) | same | Rematch, Analyze on Lichess (`openLink`), Share final position, Done (`close()`) |
| Replay (finished game) | `GET /api/games/:id` | Slider and arrows, move list, Share position, Analyse on Lichess, Download PGN (`downloadFile` on 8.0+, else `openLink`) |
| Player page | `GET /api/groups/:g/players/:u` | Record, head-to-head, recent games |
| Settings (user), a tab of its own | prefs from launch | Move confirmations, return to chat after moving, notifications, board theme and piece set (P1) |
| Group settings `s_<groupId>` | `GET /api/groups/:g/settings` | Defaults, limits, topic mode, Void game, Block or unblock user |

### 6.3 Board adapter and the move flow

`BoardAdapter` is the only module that imports chessground. Interface: `setPosition(fen, { lastMove, check, orientation })`, `setMovable({ color: 'white' | 'black' | 'none', dests })`, `onMove(cb)`, `setViewOnly(bool)`, `flip()`. Legal destinations come from chess.js in the browser: `new Chess(fen).moves({ verbose: true })` grouped by origin square, the same library and version the server uses.

Who may drag: `movable.color` is the viewer's colour only when `game.status = 'active'`, it is their turn, and the viewer is looking at the latest position. In every other case it is `'none'`; pieces do not lift and nothing is shown. Spectators get `viewOnly`. Tap-tap is chessground's `selectable` behaviour and is always on alongside drag.

Move state machine for the player to move:

```
idle ──pick up──▶ dragging ──drop on legal square──▶ [promotion? chooser over target square]
   ▲                  │ drop elsewhere: snap back, no message
   │                  ▼
   │               [needs confirmation?] pendingConfirm: the board holds the move, the tab bar hides,
   │                  │ MainButton "Confirm move", SecondaryButton "Cancel" (in-page below 7.10).
   │                  │ Cancel, leaving the screen, Telegram's deactivated (8.0) or a new ply or status
   │                  │ → snap back, send nothing
   │                  ▼ Confirm move (or no confirmation needed)
   │               sending: POST /api/games/:id/moves { uci, expectedPly, clientMoveId }
   │                  │ 200 → sent: haptic; the player stays on the board
   │                  │ 409 stale_state / not_your_turn / expired → reload state, snap back, no message
   │                  │ 422 illegal_move (should not happen; client validated) → snap back, no message
   └──────────────────┘ network error → stay in sending with exponential retry (1 s … 30 s) using the same clientMoveId;
                        MainButton shows "Retry". This is the one visible non-error state; the PRD's "no error messages"
                        covers illegal and out-of-turn input, not a dead network
```

Whether a move needs confirmation is the `moveConfirmations` preference against the game: `always`, `people` (the default: games with no `engineLevel`) or `never`, read at the drop. See the [move confirmations spec](./2026-09-24-move-confirmations-design.md).

Viewing earlier positions: tapping a move or moving the slider sets `viewingPly`; the board shows that position view-only with a "Latest" affordance. Picking up a piece is impossible there because `movable.color` is `'none'`; the player returns to the latest position first, as the PRD requires.

Haptics: `impactOccurred('light')` on drop, `'medium'` on capture, `notificationOccurred('warning')` on check, guarded by `isVersionAtLeast('6.1')`.

### 6.4 Live updates in the client

- `EventSource('/api/games/:id/events?token=…')` opened on the game route for players and spectators. `Last-Event-ID` carries the last seen `version`.
- Events: `state` (full game DTO; sent on connect when the client's version is stale and after every change) and `ping` every 20 s. There is no incremental event type; a game DTO is a few kilobytes and a snapshot removes every ordering problem.
- Reconnect triggers: `EventSource` auto-retry, `visibilitychange` to visible, `online`. On each, the client also does one `GET /api/games/:id` so a missed event during background cannot leave stale state.
- Clocks: every state carries `deadlineAt` and `serverTime`; the client stores the offset and ticks locally. When the local clock reaches zero it shows `0:00` and waits for the server's `state`; the client never declares a result.
- Draw offers, resignations and game end arrive as `state` changes; the UI derives banners from the diff between consecutive states.

### 6.5 Performance budget (PRD: under 2 s on a mid-range phone on 4G)

| Item | Budget |
|---|---|
| Initial JavaScript, gzipped | ≤ 120 KB (Preact ≈ 4, chessground ≈ 10, chess.js ≈ 25, app ≈ 60, headroom) |
| CSS, gzipped, excluding piece set | ≤ 25 KB |
| Piece set | One SVG sprite per set, ≈ 60 KB, loaded async; squares render before pieces arrive |
| Requests before first board paint | `index.html`, one JS, one CSS, `telegram-web-app.js`, one `POST /api/launch` |
| Server p95 for `/api/launch` | ≤ 150 ms |

Enforced by a bundle-size check in CI and a Lighthouse run against the staging URL in the e2e workflow.

### 6.6 Client version fallbacks

| Capability | Minimum | Fallback |
|---|---|---|
| `disableVerticalSwipes` | 7.7 | Drag may collapse the sheet on older clients; tap-tap still works, nothing is shown |
| `requestWriteAccess` | 6.9 | Skip the prompt; the user can `/start` the bot |
| `SecondaryButton` | 7.10 | In-page Cancel button |
| `HapticFeedback` | 6.1 | Skip |
| `BackButton` | 6.1 | Skip; the bottom tab bar still reaches the root of every tab |
| `downloadFile` | 8.0 | `openLink` to the PGN URL |
| `shareMessage` + `savePreparedInlineMessage` (P1) | 8.0 | Hide the share-to-chat action |

### 6.7 Theme and layout

Colours come from `themeParams` with a fixed light and dark palette for the board itself so pieces stay legible. `viewportStableHeight` sizes the board: the board width is `min(viewport width, stable height − 200 px)` so the clocks and toolbar always fit without scrolling. No horizontal scroll at any width down to 320 px.

## 7. Domain model and rules

### 7.1 Entities and state machines

**Challenge**: `pending → accepted | declined | cancelled | expired`.

| Transition | Who | Conditions |
|---|---|---|
| accept (direct) | The challenged user | Challenge pending; neither blocked |
| accept (open) | Any verified member other than the challenger | Same limits; the first committed acceptance wins (row lock) |
| decline | The challenged user | pending |
| cancel | The challenger, from the card's `Decline`/`Cancel` button or the app | pending |
| expire | Scanner | `expires_at = created_at + 24 h` passed |

Accepting creates the game in the same transaction: colours as chosen or by CSPRNG coin flip, `deadline_at = now() + T` for White (or null when there is no time control), and the challenge card is edited into the running card. A rematch, from the finished card's button or from the app, is an ordinary challenge with colours reversed and `rated` and `T` copied from the finished game; it gets a new card and the finished card is left as it is.

**Game**: `active → finished`. `finished` carries `result` and `end_reason`; `voided_at` is a flag on finished games. Voiding an active game finishes it with `end_reason = 'voided'` and no result.

| `end_reason` | `result` | Rated effect | Trigger |
|---|---|---|---|
| `checkmate` | 1-0 or 0-1 | yes | arbiter after a move |
| `stalemate`, `insufficient_material`, `fivefold_repetition`, `seventy_five_moves` | ½-½ | yes | arbiter after a move (automatic) |
| `threefold_claim`, `fifty_move_claim` | ½-½ | yes | player claim, verified by the arbiter |
| `draw_agreement` | ½-½ | yes | draw offer accepted |
| `resignation` | 1-0 or 0-1 | yes | player, after in-app confirmation |
| `timeout` | 1-0 or 0-1 | yes | deadline passed and the player to move had already moved in this game |
| `timeout_abort` | * | no | deadline passed before the player to move had made any move (White at ply 0, Black at ply 1) |
| `abort` | * | no | either player while `ply_count < 2` |
| `voided` | * (original result kept for display) | reverted | admin |

**Draw offer**: `draw_offer = { by, at_ply }` on the game. Either player may offer when no offer is pending and they have moved since their last offer. The offer stands until the opponent declines or the opponent makes a move; the offerer moving does not clear it. It can be accepted at any time while pending. This is a superset of the PRD's "on their turn" wording and is easier to explain: an offer lasts until the other side moves.

**Claims**: `claim_draw` succeeds only when the arbiter reports the current position as threefold or fifty-move claimable. The app shows the button only then; the server re-checks.

### 7.2 Arbiter (shared package, on top of chess.js 1.4)

chess.js reports `isCheckmate`, `isStalemate`, `isInsufficientMaterial`, `isThreefoldRepetition`, `isDrawByFiftyMoves`. Two facts drive the arbiter's design (Appendix A):

1. chess.js's `isGameOver()` and `isDraw()` include threefold repetition and the fifty-move rule, which are **claimable** in this product, not automatic. The arbiter never calls them.
2. chess.js's FEN omits the en passant square unless a capture is actually legal, and its threefold detection was verified to handle that case correctly, so position keys can be the first four FEN fields as chess.js emits them.

```
applyMove(fen, history, uci) →
  { legal: false }                                             // move() threw
  { legal: true, san, fenAfter, flags, outcome }
outcome (checked in this order):
  checkmate                     → finished, winner = mover
  stalemate                     → draw
  insufficient material         → draw   (K v K, K+B v K, K+N v K, K+B v K+B with same-colour bishops)
  fivefold repetition           → draw   (count of fenAfter's key across initial position + all fenAfter keys ≥ 5)
  75-move rule                  → draw   (halfmove clock ≥ 150)
  otherwise                     → continue, with claims = { threefold: isThreefoldRepetition, fiftyMove: isDrawByFiftyMoves }
```

Promotion is mandatory in the move input (`uci` of five characters); chess.js throws otherwise, and the app's promotion chooser guarantees it. SAN comes from chess.js. FIDE's broader "dead position" rule is out of scope. Timeout with an opponent who cannot mate is a loss per the PRD; see §18, item 5.

### 7.3 Clocks, reminders, expiry

Time per move `T` is one of 3600, 28800, 86400, 259200, 604800 seconds or null. After every move by X: `deadline_at = now() + T` for the opponent, `reminder_at = deadline_at − 0.1·T` when `T ≥ 28800` and the opponent has `dm_allowed`, else null. All comparisons use PostgreSQL's `now()`; application server clocks never decide anything.

Three scanners run in the `clock` role every 5 seconds. Each runs one short transaction: select up to 100 due rows with `FOR UPDATE SKIP LOCKED`, re-check each row's condition, apply the transition and enqueue its jobs, commit, then publish to the bus:

| Scanner | Query | Action |
|---|---|---|
| Forfeit | `games where status = 'active' and deadline_at <= now()` | Re-check inside the transaction; apply `timeout` or `timeout_abort`; ratings; enqueue card edit, DMs, Lichess import; publish |
| Reminder | `games where status = 'active' and reminder_at <= now()` | Enqueue reminder DM; set `reminder_at = null` |
| Challenge expiry | `challenges where status = 'pending' and expires_at <= now()` | `expired`; enqueue card edit |

Restart safety follows from the rows being the state: nothing is scheduled in memory. Detection can lag by up to 5 s plus job latency, which is within the PRD's 5 s card budget in the common case and never changes who won, because a late move is rejected by the move transaction's own deadline check (§7.4).

### 7.4 The move transaction

```
BEGIN
  game = SELECT … FROM games WHERE id = $1 FOR UPDATE
  require game.status = 'active', caller is a player, caller's colour = side to move
  if a move with (game_id, client_move_id) exists → COMMIT, return current state   // idempotent retry
  require expectedPly = game.ply_count                                            // else 409 stale_state
  if game.deadline_at < now():
      apply timeout / timeout_abort exactly as the scanner would; COMMIT; return the finished state
  r = arbiter.applyMove(game.fen, moves, uci)      → 422 illegal_move if not legal
  INSERT moves (game_id, ply, uci, san, fen_after, played_at = now(), client_move_id)
  UPDATE games SET fen, ply_count + 1, deadline_at, reminder_at, version + 1,
                   draw_offer = NULL when the mover is not the offerer
  if r.outcome ends the game: status, result, end_reason, finished_at; ratings for both players (§7.5)
  INSERT jobs: edit_card(dedup card:g:<id>), send_dm(turn → opponent) or send_result_photo(dedup result:g:<id>, human games not aborted), lichess_import when finished
COMMIT
bus.publish(gameId)   → SSE streams fetch and push the new state
return state
```

Resign, abort, draw offer, accept, decline and claim use the same skeleton with their own checks. Every action increments `version`.

### 7.5 Ratings

Per group, Glicko-2 with: start rating 1500, deviation 350, volatility 0.06, system constant τ = 0.5, convergence ε = 0.000001, deviation floor 45 and ceiling 350. A rating is **provisional** while deviation > 110.

Rating periods: each rated result is applied as its own period for both players immediately when the game ends. Inactivity is modelled before applying a result: with `d` = days since the player's last rated game in that group and φ = RD / 173.7178 on Glicko-2's internal scale, `φ² ← min(φ² + d·σ², (350 / 173.7178)²)`, which is Glicko-2's step 6 applied once per idle day. Games that end with `*` (aborts, voids) have no rating effect; casual games have none.

Snapshots: `games.white_rating_before/after`, `white_rd_before/after` and the same for Black are written when the game ends and drive the game-end screen, the finished card and the player page. `ratings` holds the current values plus W/D/L and `games_played`.

Voiding: mark the game, then rebuild the group's ratings from scratch by replaying every rated finished, non-voided game in `finished_at` order with the same inactivity model. The rebuild rewrites `ratings` and every affected game's snapshots inside one transaction and re-enqueues card edits for games whose displayed deltas changed. Cost is linear in the group's games.

Leaderboard: members with `games_played ≥ leaderboard_min_games`, not deleted, not blocked, ordered by rating then games; provisional ratings are shown with `?`.

Test vector: the worked example in Glickman's Glicko-2 paper (player 1500 / 200 / 0.06 against 1400/30 win, 1550/100 loss, 1700/300 loss, τ = 0.5) must yield 1464.06 / 151.52 / 0.05999. The implementation exposes `ratePeriod(player, results[])` so this multi-game case is testable even though production always passes one result.

### 7.6 PGN and Lichess

PGN headers: `Event "Group Chess"`, `Site` (group title), `Date` (game start, UTC), `White`, `Black` (display names), `Result`, `WhiteElo`/`BlackElo` (ratings before the game, rated games only), `TimeControl "-"` plus a custom `TimePerMove` tag in seconds, `Termination` from `end_reason`. Movetext in SAN from the moves table. Available at `GET /api/games/:id/pgn` for players and verified members, and as a download from the app.

Lichess import runs as a `lichess_import` job when a game with at least one move finishes:

- `POST https://lichess.org/api/import`, form field `pgn`, header `Authorization: Bearer LICHESS_TOKEN` when configured (200 imports per hour instead of 100). Response `{ id, url }` is stored in `games.lichess_url`, then `edit_card` is enqueued.
- The job kind has global concurrency 1 and a minimum spacing of 2 s, following Lichess's "one request at a time". A 429 pauses the kind for 60 s. Up to 8 attempts over 24 h, then `lichess_import_status = 'failed'` and the fallback link stays.
- Fallback link, present from the moment the game ends: `https://lichess.org/analysis/pgn/<SAN moves joined by "_", URL-encoded>`, the analysis-board form documented by Lichess for exactly this purpose. It shows the whole game and offers the client-side engine without any account.
- Expected volume: at the v1 target, well under 100 finished games per hour even at peak, so the queue is a safety net, not a throttle.
- Nothing links to Lichess before `status = 'finished'`; the API omits both fields for active games.

### 7.7 Position images

Superseded in detail by the [share-position snapshot design](./2026-09-24-share-position-snapshot-design.md).
A shared position is a 1024 × 1344 portrait card: a player bar above and below the board
(`renderBoardSvg`, green squares, last-move and check highlights, cburnett glyphs under
CC BY-SA 3.0), each with an avatar, name, rating, captured pieces and, on a finished game's final
position, the result tag and rating change; result badges on the kings; and a Chess Goat footer
naming the bot. Satori lays the card out with bundled Noto and Young Serif fonts (SIL OFL 1.1,
fetched at build time by `scripts/fetch-fonts.mjs` with pinned checksums) and converts the text
to paths; `@resvg/resvg-js` rasterises it.

Cache: `board_images(key, telegram_file_id)` with `key = sha256(card SVG)`. On a hit the share job
calls `sendPhoto` with the `file_id` and no upload; on a miss it uploads and stores the returned
`file_id`. The image has White at the bottom when a spectator shares and the sharer's own colour at
the bottom when a player shares.

### 7.8 Limits

| Limit | Value | Enforced in |
|---|---|---|
| Pending challenges per user per group | 3 | `challenges.create` |
| Active games per user per group | 5, admin-configurable 1–20 | `challenges.create` and `accept` |
| Concurrent games between the same pair | 2 | same |
| Challenge lifetime | 24 h | expiry scanner |
| Position shares | 20 per user per minute | `sharing.share` |
| `/chess`, `/settings` | 20 per person per group per minute | `bot` |
| API requests | 120 per user per minute | `api` middleware |
| Open SSE streams | 4 per user | `api` |
| Draw offers | 1 per player per own move | `games.offerDraw` |

## 8. Data model (PostgreSQL 16)

Primary keys are `bigint` identities; `public_id` columns are the 10-character ids used in links. All timestamps are `timestamptz`. Only the columns that carry design decisions are listed.

| Table | Columns | Notes |
|---|---|---|
| `users` | `id`, `telegram_user_id` unique nullable, `first_name`, `username`, `language_code`, `dm_allowed`, `write_access_asked_at`, `prefs jsonb` (`notifications` default true, `move_confirmations` default `people`, `board_theme`, `piece_set`), `created_at`, `last_seen_at`, `deleted_at` | Anonymisation nulls `telegram_user_id` and `username`, sets `first_name = 'Deleted player'`, clears `prefs` |
| `groups` | `id`, `public_id`, `telegram_chat_id` unique, `title`, `type`, `is_forum`, `bot_status`, `bot_is_admin`, `bot_can_pin`, `welcome_message_id`, `settings jsonb` (`default_time_per_move` 259200, `rated_default` true, `allow_open_challenges` true, `max_active_games_per_user` 5, `leaderboard_min_games` 5, `card_topic_mode` `origin`, `fixed_topic_id`), `created_at`, `updated_at` | `telegram_chat_id` changes on migration |
| `group_members` | `group_id`, `user_id`, `status` (`member`, `left`, `blocked`), `first_seen_at`, `last_seen_at`, `verified_at`, `blocked_by`, primary key (`group_id`, `user_id`) | Feeds the opponent picker and the membership ladder |
| `challenges` | `id`, `public_id`, `group_id`, `challenger_id`, `opponent_id` nullable, `time_per_move` nullable, `challenger_colour` (`white`, `black`, `random`), `rated`, `status`, `message_id`, `thread_id`, `game_id`, `created_at`, `expires_at`, `resolved_at` | Index on (`status`, `expires_at`) |
| `games` | `id`, `public_id`, `group_id`, `white_id`, `black_id`, `time_per_move`, `rated`, `status`, `result`, `end_reason`, `fen`, `ply_count`, `version`, `deadline_at`, `reminder_at`, `draw_offer_by`, `draw_offer_ply`, `last_draw_offer_ply_white`, `last_draw_offer_ply_black`, `card_message_id`, `card_thread_id`, `card_missing`, `lichess_url`, `lichess_import_status`, `white_rating_before`, `white_rating_after`, `white_rd_before`, `white_rd_after`, same four for Black, `voided_at`, `voided_by`, `started_at`, `finished_at`, `last_move_at` | Partial indexes on `deadline_at` and `reminder_at` where `status = 'active'`; index on (`group_id`, `status`, `last_move_at`) |
| `moves` | `game_id`, `ply`, `uci`, `san`, `fen_after`, `played_at`, `client_move_id`, primary key (`game_id`, `ply`), unique (`game_id`, `client_move_id`) | The replay and PGN source |
| `ratings` | `group_id`, `user_id`, `rating`, `rd`, `volatility`, `games_played`, `wins`, `draws`, `losses`, `last_rated_game_at`, primary key (`group_id`, `user_id`) | Projection; rebuilt on void |
| `shares` | `id`, `game_id`, `user_id`, `ply`, `message_id`, `created_at` | Rate limit and the "positions shared per 10 games" metric |
| `board_images` | `key` primary key, `telegram_file_id`, `created_at` | |
| `jobs` | `id`, `kind`, `dedup_key`, `payload jsonb`, `run_at`, `attempts`, `max_attempts`, `locked_until`, `locked_by`, `last_error`, `created_at`, `done_at` | Unique partial index on `dedup_key` where `done_at is null`; index on (`run_at`) where `done_at is null` |
| `telegram_updates` | `update_id` primary key, `received_at` | Pruned after 7 days |
| `admin_actions` | `id`, `group_id`, `admin_user_id`, `action` (`void`, `block`, `unblock`, `settings`), `target_game_id`, `target_user_id`, `details jsonb`, `created_at` | Audit trail |

Sessions are stateless tokens (HS256 JWT with `SESSION_SECRET`, claims `sub = users.id`, `exp = 24 h`), so there is no sessions table.

## 9. API between the Mini App and the server

All routes are under `/api`, JSON in and out, validated with the zod schemas in the shared package. Errors use `{ "error": { "code", "message" } }` with codes `unauthorized`, `forbidden`, `not_found`, `stale_state`, `not_your_turn`, `illegal_move`, `expired`, `limit_exceeded`, `rate_limited`, `validation`. The Mini App never shows `message` strings for board actions; they exist for logs and tests.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /launch` | `initData` | Validate, upsert user, resolve `start_param`, return `{ token, user, prefs, route, data, serverTime }` |
| `GET /me/games` | session | The user's active games across those groups, their own turn first |
| `GET /me/groups` | session | Groups where the user is a verified member with the bot present |
| `PUT /me/prefs` | session | Preferences, write-access prompt result |
| `DELETE /me` | session | Delete my data: resigns active games, cancels pending challenges, anonymises (§12) |
| `GET /groups/:g` | member | Lobby payload |
| `GET /groups/:g/players` | member | Known players for the picker |
| `GET /groups/:g/leaderboard`, `GET /groups/:g/players/:u` | member | Players tab and player page |
| `GET /groups/:g/finished?cursor=` | member | Finished games, newest first, 20 per page |
| `POST /groups/:g/challenges` | member | `{ opponentId or null, timePerMove, colour, rated }` |
| `POST /challenges/:c/accept`, `/decline`, `/cancel` | member | Per §7.1 |
| `GET /games/:id` | player or member | Full game DTO: players with ratings, `fen`, moves (`uci`, `san`, `fenAfter`, `playedAt`), `plyCount`, `version`, `deadlineAt`, `serverTime`, `drawOffer`, `claims`, `viewerRole` (`white`, `black`, `spectator`), `status`, `result`, `endReason`, rating snapshots, `lichessUrl` and `analysisUrl` when finished |
| `GET /games/:id/events` | player or member | SSE; `Last-Event-ID` = version; events `state`, `ping` |
| `POST /games/:id/moves` | player | `{ uci, expectedPly, clientMoveId }` → game DTO |
| `POST /games/:id/draw/offer`, `/accept`, `/decline`, `/claim` | player | |
| `POST /games/:id/resign`, `/abort` | player | |
| `POST /games/:id/share` | player or member | `{ ply }` → `{ ok }`; enqueues the photo job |
| `POST /games/:id/rematch` | player | Creates the reversed-colour challenge |
| `GET /games/:id/pgn` | player or member | `application/x-chess-pgn` |
| `GET /groups/:g/settings`, `PUT /groups/:g/settings` | admin | |
| `POST /games/:id/void`, `POST /groups/:g/blocks`, `DELETE /groups/:g/blocks/:u` | admin | Audit-logged |
| `POST /telemetry` | session | Client load errors and move failures, sampled and rate-limited (§14) |
| `POST /telegram/webhook` | secret header | Bot updates |

The SSE route needs the session token in the query string because `EventSource` cannot set headers; the token is scoped and short-lived, the route only ever reveals what `GET /games/:id` would, and access logs redact the query string on this route. Responses are `Cache-Control: no-store`.

## 10. Jobs and scheduling

The `jobs` table is the outbox for every side effect. The worker polls every second with `SELECT … WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED`, leases each row for 60 s, runs the handler, and marks `done_at` or reschedules with backoff `min(5 s · 2^attempts, 1 h)`. Enqueueing with a `dedup_key` that already has a pending row updates that row's `run_at` instead of inserting; handlers therefore render from current state, never from the payload alone.

| Kind | Payload | Dedup | Handler |
|---|---|---|---|
| `send_challenge_card` | `challengeId` | `card:send:<challengeId>` | `sendMessage` to the group and topic; store `message_id` |
| `edit_card` | `gameId` or `challengeId` | `card:g:<gameId>` or `card:ch:<challengeId>` | Render current state; `editMessageText`; treat "not modified" as done; retry when the card has no `message_id` yet |
| `send_share_photo` | `shareId` | none | Render or reuse image; `sendPhoto` with caption and `Open game` |
| `send_dm` | `userId`, `template`, `gameId` | `dm:<user>:<game>:<template>:<ply>` | Skip when `dm_allowed` is false; 403 flips the flag |
| `send_welcome` | `groupId` | `welcome:<group>` | `sendMessage`, then `pinChatMessage` when allowed |
| `send_message` | `chatId`, `threadId`, `template`, `params`, `replyToMessageId` | none | One-line command replies, the `/chess`, `/settings` and `/start` buttons |
| `lichess_import` | `gameId` | `lichess:<game>` | §7.6; kind-level concurrency 1 |
| `rebuild_ratings` | `groupId` | `ratings:<group>` | §7.5 |
| `prune` | none | `prune` | Daily: `telegram_updates` > 7 d, done jobs > 30 d |

Telegram pacing lives in the outbound client used by the handlers (§5.8): a 429 reschedules the job at `now() + retry_after` and pauses the chat's lane. Time-based transitions (deadlines, reminders, expiry) are not jobs; they are scanners (§7.3), so a job backlog can never delay a forfeit decision.

## 11. Error handling and failure modes

| Failure | Detection | Handling | What people see |
|---|---|---|---|
| Telegram 429 on a send or edit | `retry_after` in the response | Job rescheduled at `now() + retry_after`; the chat's lane pauses | A card or DM arrives late; the game is unaffected |
| Telegram "message is not modified" | 400 with that description | Counted as success | Nothing |
| Telegram "message to edit not found" or "message can't be edited" | 400 | `games.card_missing = true`; no further edits | The card stops updating; the app is unaffected |
| Telegram "bot was blocked by the user" or "user is deactivated" | 403 on a DM | `dm_allowed = false`; job done | No more DMs; the lobby badge still works |
| Telegram "bot was kicked" or "chat not found" on a group send | 403 or 400 | `bot_status = 'left'`; group posts stop | Games continue in the app |
| Group upgraded to supergroup | `migrate_to_chat_id` service message, or a 400 carrying the new id | `telegram_chat_id` updated; the job retries | Nothing |
| Duplicate webhook delivery | `telegram_updates` primary key | 200, no effects | Nothing |
| Crash inside a webhook handler | Exception | Transaction rolls back, 500, Telegram retries, the guard keeps it single | Nothing |
| Crash during a job after the Telegram call succeeded | Lease expires after 60 s | Another worker reruns it. Edits are idempotent; sends are at-least-once, so a duplicate DM after a crash is accepted | Rarely, a repeated DM |
| Database unavailable | Query errors | API returns 503 with `Retry-After`; the webhook returns 500; scanners and workers back off | The app shows "Reconnecting…" and retries; SSE reconnects |
| Lichess unavailable or 429 | HTTP status | Import retried for 24 h; the fallback link is already on the card | `Analyse on Lichess` opens the analysis board instead of an imported game |
| Image rendering fails | Exception in the share job | Three attempts, then failed | In-app "Couldn't share this position" notice; no group message |
| Reverse proxy buffers SSE | Streams never deliver | `X-Accel-Buffering: no`, `Cache-Control: no-store`, 20 s pings; a deployment checklist item verified on staging | None once configured |
| Client state is stale (409) | Response code | Refetch and snap back silently | The board updates; no message |
| Client offline mid-move | Fetch error | Retry with the same `clientMoveId` | "Sending…" then "Retry" |
| `initData` older than 24 h | `auth_date` | 401 on launch | "Reopen from Telegram" screen |
| Move arrives after the deadline | Move transaction compares with `now()` | The transaction applies the timeout itself | The player sees the finished state |
| Two people accept an open challenge at once | Row lock | The second commit fails with `stale_state` | `answerCallbackQuery` alert "Someone accepted first"; a private toast, not a group message |
| Wrong person taps Accept, Decline or Rematch | Identity check | `answerCallbackQuery` alert ("Only @bob can accept this challenge") | Private toast only |
| Bystander taps Cancel on an open challenge | Identity check | `answerCallbackQuery` alert ("Only @alice can withdraw this challenge"); the challenger's own tap withdraws it | Private toast only |
| Job exhausts its attempts | `attempts = max_attempts` | `last_error` kept, `jobs_failed_total` increments, alert | Depends on the kind; the game state is never affected |

## 12. Security and privacy

**Authentication.** `POST /api/launch` validates `initData` with Telegram's recipe: parse the query string, remove `hash`, sort the remaining `key=value` pairs, join with `\n`, compute `HMAC-SHA256(key = HMAC-SHA256("WebAppData", BOT_TOKEN), data)` and compare in constant time; reject when `auth_date` is older than 24 h or `user` is missing. The unit test uses the worked example from Telegram's Mini Apps documentation plus tampered and stale variants. The session token is an HS256 JWT (`sub`, `iat`, `exp` = 24 h) signed with `SESSION_SECRET`; rotating the secret logs everyone out, which is acceptable.

**Authorization matrix.**

| Action | Allowed for |
|---|---|
| View lobby, players, finished games, PGN | Verified member of the group (§5.6) |
| View a game, watch its stream, share a position | The two players always; otherwise verified member |
| Move, offer or accept or decline or claim a draw, resign, abort | The player concerned, on the server's view of whose turn it is |
| Accept a direct challenge | The challenged user |
| Accept an open challenge | Verified member other than the challenger, not blocked |
| Decline or cancel a challenge | The challenged user (decline) or the challenger (cancel) |
| Rematch | Either player of the finished game |
| Read or change group settings, void, block, unblock | Group administrator or owner per `getChatAdministrators`, checked on every request |
| Delete my data | The user themselves |

**Input validation.** Every body and query is parsed with the shared zod schemas. UCI moves match `^[a-h][1-8][a-h][1-8][qrbn]?$`; public ids match `^[A-Za-z0-9]{10}$`; ply is bounded by `ply_count`. Request bodies are capped at 64 KB, the webhook at 1 MB.

**Transport and browser.** HTTPS only. Mini App CSP: `default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` (chessground positions pieces with inline styles). No third-party scripts, fonts or analytics. Session tokens are held in memory, never in `localStorage`.

**Webhook.** Secret header check; optional allow-list of Telegram's published address ranges at the proxy.

**Privacy.** Privacy mode stays on. The server reads only the command entity of a message and the sender's id and name; message text is never stored or logged. Logs carry numeric ids and public ids only, never `initData`, tokens or names. Stored per user exactly the fields in PRD §7.12.

**Delete my data.** Immediate and irreversible: resign the user's active games (the opponent wins, rated as usual), cancel their pending challenges, then anonymise the `users` row (§8). Their `ratings` rows stay so other players' histories remain consistent, but a deleted user never appears on a leaderboard or player list. A later `/start` creates a new user.

**Retention and backups.** Games indefinitely (PRD). `telegram_updates` 7 days, finished jobs 30 days, logs 30 days. Daily database snapshots retained 30 days, encrypted at rest; a restore drill before the beta.

**Supply chain.** Lockfile committed, Dependabot weekly, `pnpm audit` in CI, and a licence allow-list (MIT, BSD, Apache-2.0, MPL-2.0, Unlicense, GPL-3.0-or-later), all compatible with the repository's GPL-3.0-or-later.

## 13. Non-functional requirements mapped to the design

| PRD §11 requirement | Mechanism | Budget or evidence |
|---|---|---|
| Move visible to opponent and spectators within 2 s (p95) | Move transaction, in-process bus, SSE push | Transaction ≤ 50 ms, push ≤ 100 ms; measured by `move_latency_seconds` |
| Card status edit within 5 s | `edit_card` job, 1 s worker poll | Worker latency plus one Telegram call; measured by `jobs_oldest_age_seconds{kind="edit_card"}` |
| 99.5 % monthly availability (≈ 3.6 h) | One container with health checks and automatic restart; managed PostgreSQL; rolling or sub-30 s deploys | Nothing is lost during downtime: clocks are rows, updates are retried by Telegram, jobs wait |
| Clocks and forfeits exact across restarts | Database time and the deadline check inside the move transaction | Integration tests race a move against the scanner |
| 5,000 groups and 1,000 concurrent games with 10× headroom | Capacity estimate: at one-day controls ≈ 2 moves per game per day → ≈ 2,000 moves per day, average 0.02 per second, peak assumed 100× average ≈ 2.5 per second; each move is one transaction and two jobs. Storage ≈ 200 bytes per move → under 200 MB per year at 10× | A single small PostgreSQL instance and one Node process are an order of magnitude above 10× target; load test in §15 proves it |
| Spectators | Assume 5 % of active games watched at any moment → 50 streams at target, 500 at 10× | Node holds tens of thousands of idle SSE streams |
| Data kept indefinitely, daily backups | §12 | Restore drill |
| Mini App loads in under 2 s on a mid-range phone on 4G | §6.5 budgets, one launch request | Lighthouse in CI against staging |
| iOS, Android, Desktop, Web clients | §6.6 fallbacks, device matrix in §15 | Alpha exit |
| Strings externalised, English at launch | ICU message catalog in the shared package, used by both server (cards, DMs) and app | `language_code` stored for later |
| Observability | §14 | Dashboards from day one of the alpha |

## 14. Observability

**Metrics** (Prometheus format from `/metrics`, protected by network policy): `moves_total`, `move_latency_seconds` (request received → bus publish), `sse_streams`, `sse_reconnects_total`, `telegram_api_calls_total{method,status}`, `telegram_429_total`, `jobs_pending{kind}`, `jobs_oldest_age_seconds{kind}`, `jobs_failed_total{kind}`, `scanner_lag_seconds{scanner}` (age of the oldest due row), `lichess_imports_total{outcome}`, `webhook_updates_total{type}`, `game_opens_total{role}`, `miniapp_load_errors_total`, `miniapp_move_failures_total`, `games_started_total`, `games_finished_total{end_reason}`, `shares_total`, `active_groups`.

**Client telemetry.** The app posts to `/api/telemetry` on: launch failure (script or API), move submission that ends in `Retry`, SSE that fails to connect for 30 s. Sampled at 100 % during alpha, rate-limited per user, containing only codes and timings.

**Logs.** pino JSON with a request id per webhook update and API request, numeric and public ids only.

**Alerts.** Webhook 5xx above 1 % over 5 min; `jobs_oldest_age_seconds` above 60; `scanner_lag_seconds` above 30; Telegram 5xx or 429 spikes; Lichess failure ratio above 50 % over an hour; `miniapp_load_errors_total` above 1 % of launches; database connection errors.

**Health.** `/healthz` (process up) and `/readyz` (database reachable, migrations applied). The PRD §12 success metrics are SQL over `games`, `moves`, `shares` and `game_opens_total`, produced by a weekly report job.

## 15. Testing strategy

| Layer | Tooling | What it must cover |
|---|---|---|
| Unit | vitest | Arbiter: fivefold and 75-move detection, threefold and fifty-move claimability, en passant repetition case, insufficient-material table, checkmate precedence over the 75-move rule, mandatory promotion. Glicko-2: the paper's vector, inactivity inflation, floor and ceiling, void rebuild equals a fresh computation. PGN round trip through chess.js `loadPgn`. Start-payload and callback codecs. Card renderer snapshots for every state in §5.4. `initData` validator with the documented vector, a tampered hash and a stale `auth_date`. Clock math for every time control |
| Integration | vitest with a real PostgreSQL (testcontainers locally, a service container in CI) and a local fake Bot API server that grammY is pointed at | Move transaction races: two moves, a move against the forfeit scanner, two accepts of an open challenge; idempotent move retry; scanners; job dedup and coalescing; webhook idempotency; the membership ladder with and without admin rights; outbound pacing and 429 handling; delete-my-data |
| End to end | Playwright, Chromium with touch emulation, against the server plus a dev harness that injects a fake `window.Telegram.WebApp` with configurable version and test-signed `initData` | Drag move, tap-tap move, promotion, spectator cannot lift a piece, view earlier position then return, replay slider, live update between two browser contexts, version fallbacks on a simulated 6.0 client, bundle-size and Lighthouse budgets |
| Device matrix (manual, before alpha exit) | Real devices | iPhone and Android with current Telegram, Telegram Desktop, Web K and Web A: 50 drag moves each without a missed drop; card → move → back in chat; background five minutes → resume shows the latest state; DM buttons |
| Load | k6 | 10× target: 25 moves per second for 10 minutes with 2,000 SSE streams; server p95 move latency under 300 ms; no growth in `jobs_pending` |

Alpha exit criteria from PRD §13 map to: 50 completed games (metrics), no rule bugs (the arbiter suite, plus every finished alpha game imported into Lichess, which rejects illegal PGNs and so doubles as an independent legality check), drag reliability confirmed (device matrix and `miniapp_move_failures_total` under 1 % of moves).

## 16. Repository layout, tooling, CI

```
.
├── apps/
│   ├── server/            # Node 22: bot, api, domain, telegram, jobs, clock, lichess, images, bus, db
│   └── miniapp/           # Preact + Vite: tg, api, board, routes, i18n
├── packages/
│   └── shared/            # arbiter, pgn, glicko2, protocol (zod), i18n catalog
├── docs/                  # PRD.md, superpowers/specs, superpowers/plans
├── .github/workflows/     # ci.yml (PR), e2e.yml (PR and main), release.yml (tags)
├── Dockerfile             # multi-stage: build miniapp, bundle into the server image
├── LICENSE                # GPL-3.0-or-later (D2)
└── pnpm-workspace.yaml
```

Tooling: pnpm workspaces, TypeScript strict, ESLint and Prettier, vitest, Playwright, drizzle-kit migrations, zod, pino, `.nvmrc` pinning Node 22. CI on pull requests: lint, typecheck, unit, integration with a PostgreSQL service, bundle-size check, and the end-to-end suite with the dev harness plus the Docker build — the navigation specs guard behaviour no unit test reaches, so they gate a PR rather than only `main`. On tags: push the image and deploy staging; production is a manual promotion. Dependabot weekly and the licence allow-list from §12.

## 17. Spikes to run before the implementation plan

Each is a throwaway probe of half a day to a day, with a go criterion and a fallback, per the brainstorming skill's spike path.

| Spike | Method | Go when | If it fails |
|---|---|---|---|
| S1 Drag reliability | A static page with chessground, `expand()` and `disableVerticalSwipes()`, opened as a Mini App on iPhone and Android | 50 drags each without the sheet collapsing or a missed drop | Try `requestFullscreen()`; add a short hold delay before a drag starts; tap-tap remains the guaranteed path |
| S2 Open and return round trip | A card with a direct-link button in a test group; open, call `close()`, on iOS, Android, Desktop, Web K, Web A | Every client returns to the group chat | Hide **Done** on the failing client; Telegram's own close remains |
| S3 SSE inside the WebView | The probe page holds an `EventSource`; background the app for five minutes, resume | Stream resumes or reconnects within 3 s on both platforms | Poll every 3 s on that platform; the transport is isolated |
| S4 Bot API behaviours | A test bot in a supergroup with and without admin rights | `getChatMember` behaviour for non-admin bots is characterised; General-topic `message_thread_id` handling confirmed; `text_mention` renders for a member without a username; `write_access_allowed` arrives after `requestWriteAccess()` | Adjust the ladder in §5.6 and the topic rule in §5.8 |

## 17a. Amendment, 2026-09-22: no caps on concurrent games

The group setting `maxActiveGamesPerUser` and the `MAX_GAMES_PER_PAIR = 2` constant were removed. Only
the pending-challenge cap remains, because that one limits unanswered invitations sitting in other
people's notifications rather than a player's own play.

The bot opponent exposed why the caps were wrong. A bot game has no clock, so nothing ever ends one on
its own — no forfeit scanner, no prune. Combined with a cap, two abandoned bot games became a
permanent lockout, and because the group-wide cap counted every active game it blocked challenging
*people* as well, behind a generic error message. Removing the caps removes the lockout at its source
instead of adding a cleanup job to work around it.

What this gives up: nothing bounds how many concurrent games a player accumulates, so a group's active
list can grow long and abandoned games linger in it with nothing to clear them. That is a display
problem rather than a correctness one, and the fix, if it is ever wanted, is pagination or a cleanup
pass — not a cap.

## 18. Open items for the user

1. Confirm D1 (TypeScript end to end) and D2 (chessground, repository licensed GPL-3.0-or-later) and add the `LICENSE` file. Everything else in this document survives a change of UI framework; a change of server language keeps the structure of §4 to §17 and changes the library names.
2. Hosting provider and domain for `PUBLIC_URL` (D8).
3. Bot username and Mini App short name (PRD open question 7).
4. A Lichess account to issue the app token (D9). Without it the import limit is 100 per hour, still ample.
5. Rule question: the PRD scores a timeout as a loss even when the opponent cannot mate; Lichess and Chess.com score it a draw, following FIDE Article 6.9. It is one branch in the arbiter. Recommendation: the draw.
6. Draw offers can be accepted at any time while pending (§7.1), a superset of the PRD's "on their turn". Confirm.
7. `Rematch` on aborted cards (§5.4) is an addition; the PRD does not specify aborted cards.
8. PRD open questions 1, 2, 3 and 6 need no technical decision. The defaults are implemented as preferences and settings: close after move on, no group-mention fallback, per-group ratings.

## Appendix A. Verified facts (2026-09-20)

Sources: the npm registry; chess.js 1.4.0 executed locally; the community JSON mirror of the official Bot API specification (Bot API 10.3, 24 August 2026); the Telegram Mini Apps community documentation on GitHub; the Lichess OpenAPI specification on GitHub. `core.telegram.org` and `lichess.org` were unreachable from the sandbox, so the PRD §9 verification (2026-09-20) remains the reference for Mini App method version tags.

| Fact | Source |
|---|---|
| chess.js 1.4.0, BSD-2-Clause; chessground 9.2.1, GPL-3.0-or-later; react-chessboard 5.12.1, MIT, depends on `@dnd-kit/core`, peer React 19; chessops 0.15.1, GPL-3.0-or-later; grammy 1.46.0; hono 4.13.8; drizzle-orm 0.45.2; postgres 3.4.9; preact 10.29.8; vite 8.3.0; zod 4.6.5; pino 10.3.1; @resvg/resvg-js 2.6.2, MPL-2.0; @telegram-apps/init-data-node 2.0.10 | npm registry |
| chess.js detects threefold repetition after 1.e4 e5 2.Nf3 Nf6 3.Ng1 Ng8 4.Nf3 Nf6 5.Ng1 Ng8; its FEN shows `-` for en passant after 1.e4 and the square only when a capture is legal | executed |
| chess.js `move()` throws on an illegal move and on a promotion without a piece; `isDrawByFiftyMoves`, `isInsufficientMaterial`, `isThreefoldRepetition` exist; no fivefold or 75-move method; `isGameOver()` is true at halfmove clock 100 | executed |
| `isInsufficientMaterial`: true for K v K, KB v K, KN v K, KB v KB same colour; false for opposite-colour bishops, KN v KN, KN v KNN | executed |
| `callback_data` is 1–64 bytes; `web_app` inline buttons work only in private chats; `secret_token` is sent as `X-Telegram-Bot-Api-Secret-Token`; the default `allowed_updates` excludes `chat_member`; `getChatMember` is only guaranteed for other users when the bot is an administrator; `getChatAdministrators` has no such caveat; `pinChatMessage` needs `can_pin_messages`; `sendPhoto` limits (10 MB, width + height ≤ 10000, ratio ≤ 20); `message_thread_id` for forum supergroups; `WriteAccessAllowed` fields `from_request`, `web_app_name`, `from_attachment_menu`; `migrate_to_chat_id`; `BotCommandScopeAllGroupChats`; `savePreparedInlineMessage` | Bot API 10.3 spec mirror |
| `startapp` allows `A-Z a-z 0-9 _ -`, up to 512 characters, regex `/^[\w-]{0,512}$/`, duplicated in `initData.start_param` | Mini Apps docs |
| `initData` validation: sorted `key=value` pairs joined with `\n`, HMAC-SHA256 keyed by HMAC-SHA256("WebAppData", bot token), hex comparison; a worked example with token, payload and expected hash is available as a test vector | Mini Apps docs |
| `POST /api/import`: form field `pgn`, response `{ id, url }`, 200 per hour with OAuth, 100 anonymous; "only make one request at a time", wait a minute after a 429; analysis-board URL form `https://lichess.org/analysis/pgn/e4_e5_Nf3_Nc6_Bc4_Bc5_Bxf7+` | Lichess API spec |
| Glicko-2 worked example: 1500 / 200 / 0.06 with τ = 0.5 against 1400 (30) win, 1550 (100) loss, 1700 (300) loss → 1464.06 / 151.52 / 0.05999 | Glickman, "Example of the Glicko-2 system" |
| Telegraf 4.16.3 (latest) declares Bot API 7.1 in its README and depends on `@telegraf/types ^7.1`; grammY 1.46.0 declares Bot API 10.3 and depends on `@grammyjs/types 5.0.0`, published 2026-08-25, one day after Bot API 10.3; `@grammyjs/auto-retry` 2.0.2 and `@grammyjs/transformer-throttler` 1.2.1 last published 2025-03-01; `telegraf-throttler` 0.6.0 and `telegraf-ratelimit` 2.0.0 last published in 2022 | npm registry; the two projects' READMEs on GitHub |
| hono 4.13.8, `@hono/node-server` 2.1.1, `@hono/zod-validator` 0.9.1; fastify 5.12.5; express 5.2.1; kysely 0.29.6, kysely-codegen 0.20.0; drizzle-kit 0.31.10; `@prisma/client` 7.10.0 | npm registry |

## Appendix B. Glossary

| Term | Meaning |
|---|---|
| Ply | One move by one side; `ply_count` 0 is the initial position |
| SAN, UCI | Standard Algebraic Notation (`Nf3`) and coordinate notation (`g1f3`, `e7e8q`) |
| FEN | Forsyth–Edwards Notation for a position; the first four fields identify a position for repetition |
| PGN | Portable Game Notation, the export and import format |
| RD | Rating deviation in Glicko-2; large means uncertain, provisional above 110 |
| `initData` | The signed launch payload Telegram gives a Mini App |
| Direct link | `t.me/<bot>/<app>?startapp=…`, the only Mini App button that works inside groups |
| Card | The single bot message per game in the group chat |
