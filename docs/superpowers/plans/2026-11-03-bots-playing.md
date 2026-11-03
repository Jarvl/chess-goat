# Bots 2: Playing in Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots can be placed in groups and play there under the bot rules. Humans may challenge bots, and bots may challenge bots, but bots never challenge humans. Bot-vs-bot play never posts to the chat. Human-vs-bot games always have a clock. Bot ratings are a separate pool, and human ratings never move because of a bot game. Admins can block bots, and blocking a human also blocks their bots. Bot activity is tracked and shown. This covers milestone "Bots 2: playing in groups", issues #96–#101.

**Architecture:**
- **Bot membership.** A bot "is in" a group when it has a `group_members` row with status `member`. Only its owner can create that row, and only while the owner is a member and not blocked. Existing blocks and `group_members` queries therefore work for bots unchanged.
- **Bot player count.** `games` and `challenges` gain a `bot_players` count (0, 1 or 2), fixed at creation. Every side effect (cards, DMs, result photos, lobby listing, the stale-game scanner) branches on that count, so nothing has to re-load both players.
- **Ratings.** The shared `applyRatedGame` gains a "frozen side" option. In a rated human-vs-bot game, only the bot's state moves.
- **No MCP here.** Bots can't call anything yet; that is milestone 3. This milestone adds the domain rules and their tests, plus the few UI and card changes humans see. Milestone 3 drives bots through these same domain functions.

**Tech Stack:** TypeScript, Node 22, Hono, grammY, drizzle-orm 0.45 and drizzle-kit, PostgreSQL 18, zod 4, Preact (Mini App), vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-bot-accounts-design.md` (§2 Groups and admins, §3 Challenges and games, §4 Ratings, §6 "Where bot games are listed").

## Global Constraints

- **Bots never challenge humans.** A challenge whose challenger is a bot must name an opponent who is a bot. Open challenges and username challenges from bots are refused. The server enforces this whatever the caller sends.
- **Nothing about bot-vs-bot play reaches the chat.** That covers challenge cards, game cards, card edits, result photos, DMs and reminders. The lobby doesn't show it either.
- **Human-vs-bot:** always on a time-per-move clock. `timePerMove: null` is refused. A challenge card is posted, and a result card always posts. Bots and owners get no DMs, but the human still gets their normal DMs.
- **Bot-vs-bot:** no clock unless the challenger sets one. A clockless bot-vs-bot game with no move for **30 days** (counted from `lastMoveAt`, or `startedAt` if nobody has moved) is aborted: result `*`, end reason `abort`, no rating change.
- **Same-owner games are always casual.** This covers an owner against their own bot and two bots with the same owner. The server forces `rated: false`.
- **Ratings stay per group.** Rated bot-vs-bot games update both bots. Rated human-vs-bot games update **only the bot**, using the human's current rating as the opponent rating. A human's `ratings` row is never created or changed by a bot game.
- **A bot may play in a group only when** it has a `member` row there, it isn't blocked, its owner has a `member` row there, and the owner isn't blocked. If the owner leaves or is blocked, the bot can't take or issue new challenges there. Live games continue.
- **Blocks:** an admin blocks a bot like a human. Blocking a human also blocks all their bots in that group, and a blocked owner can't add bots there. Blocking a bot, or the owner of bots, cancels the pending challenges those bots are part of.
- **Bots never auto-accept.** A challenge to a bot is accepted only by `acceptChallenge` with the bot's id. That call comes from milestone 3. Challenges to bots expire as normal (24 h).
- **Activity:** a bot's last activity is the new nullable `users.last_active_at`, which is null until the bot's first activity. `touchBotActivity` writes it at most once a minute. "Active now" means within 5 minutes. (`last_seen_at` is `NOT NULL DEFAULT now()`, so it can't express "never".)
- **Error codes** come from the existing `ERROR_CODES`. Reasons are new strings in `details.reason`:
  - `forbidden` / `bots_challenge_bots_only`
  - `validation` / `bot_games_need_clock`
  - `forbidden` / `bot_not_in_group`
  - `forbidden` / `owner_not_member`
  - `forbidden` / `blocked` (already exists)
- **Run commands with Node on PATH:** `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`. Postgres must already be running on 54329. Single file: `cd apps/<pkg> && pnpm exec vitest run <file>`. Before each commit, at the root: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`. Generated drizzle output must be run through `prettier --write`.

## Review Focus

1. **A bot-vs-bot challenge is cancelled, declined, expires or is accepted.** No Telegram job (card, edit or DM) is ever enqueued. In particular, `edit_card` on a row with no message would retry forever. Test in Task 3 and Task 4.
2. **A human challenges a bot, then the bot's owner leaves the group before the bot accepts.** The accept is refused with `owner_not_member`, and the human's card still reads correctly. Test in Task 3.
3. **A rated human-vs-bot game is voided, triggering a rebuild of the group's ratings.** The human's rating comes out exactly as if the game never happened, and the bot's comes out as if only its games counted. Test in Task 6.
4. **An admin blocks the owner while the owner's bot is mid-game against someone.** The live game continues, but the bot's pending challenges are cancelled and new ones are refused. Test in Task 2.
5. **A clockless bot-vs-bot game exactly at the 30-day boundary, or a clocked bot-vs-bot game idle for 30 days.** The first is aborted only after the boundary. The second is never touched by the stale scanner, because its own clock handles it. Test in Task 5.

---

### Task 1: Schema: `bot_players` on games and challenges, `last_active_at` on users

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0016_bot_players.sql`, generated and then prettier'd along with its meta files
- Modify: `apps/server/test/helpers/fixtures.ts`, so `insertGame` and `insertChallenge` accept `botPlayers`
- Test: `apps/server/test/integration/db.test.ts`, or a new `bot-players.test.ts`

**Interfaces:**
- Produces: `games.botPlayers: number` and `challenges.botPlayers: number`. Both are `smallint not null default 0`, with check constraints `games_bot_players_range` and `challenges_bot_players_range` limiting them to 0–2.
- Produces: `countBotPlayers(a: Pick<UserRow,'ownerId'>, b: Pick<UserRow,'ownerId'> | null): 0 | 1 | 2` in `apps/server/src/domain/bots.ts`.
- Produces: `users.lastActiveAt: Date | null` (nullable `last_active_at`, no default).
- Produces: the index `games_bot_vs_bot_stale` on `(coalesce(last_move_at, started_at))` where `status = 'active' and bot_players = 2 and time_per_move is null`.

- [ ] **Step 1: Write the failing tests.**
  - `bot_players defaults to 0 and rejects 3`: insert a game with `botPlayers: 3` and expect a check violation.
  - Unit test `countBotPlayers`: human/human → 0, human/bot → 1, bot/bot → 2, bot/null → 1.
- [ ] **Step 2: Run them to see them fail.** `cd apps/server && pnpm exec vitest run test/integration/bot-players.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the columns (including `users.last_active_at`), checks and index to `schema.ts`, then run `pnpm db:generate` and `prettier --write` on the output. Add `countBotPlayers`. Extend the fixtures.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `test/integration/stats-views.test.ts test/integration/migrate-reset.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: count bot players on games and challenges"`

### Task 2: Bots in groups, and blocks

**Files:**
- Create: `apps/server/src/domain/botGroups.ts`
- Modify: `apps/server/src/domain/members.ts` (`isBlocked`)
- Modify: `apps/server/src/domain/admin.ts` (`adminBlock`, `groupSettingsDto`)
- Modify: `packages/shared/src/protocol/dto.ts` (`GroupSettingsDto.bots`)
- Modify: `apps/miniapp/src/ui/screens/GroupSettings.tsx`
- Test: `apps/server/test/integration/bot-groups.test.ts` (create), `apps/miniapp/test/groupSettings.test.tsx`

**Interfaces:**
- Consumes: `requireOwnBot` (domain/bots.ts) and `touchMember` (members.ts).
- Produces (in `domain/botGroups.ts`):
  - `addBotToGroup(tx: DbOrTx, ownerId: number, botId: number, groupId: number): Promise<void>`. It refuses `owner_not_member` when the owner has no `member` row in the group, and `blocked` when the owner or the bot is blocked there. It is idempotent.
  - `removeBotFromGroup(tx: DbOrTx, ownerId: number, botId: number, groupId: number): Promise<void>`. It marks the bot's row `left` and cancels the bot's pending challenges in that group (status `cancelled` if the bot sent them, `declined` if they were sent to it). It enqueues `edit_card` only for challenges with `botPlayers < 2`.
  - `assertBotMayPlay(tx: DbOrTx, groupId: number, bot: Pick<UserRow,'id'|'ownerId'>): Promise<void>`. It throws `bot_not_in_group`, `owner_not_member` or `blocked`, per the "may play" rule in Global Constraints.
  - `listGroupBots(tx: DbOrTx, groupId: number): Promise<UserRow[]>`. Live bots with a `member` row in the group, ordered by name.
- Produces: `isBlocked(tx, groupId, userId)` also returns true for a bot whose owner is blocked in that group. It still does one query.
- Produces: `adminBlock` cancels pending challenges in that group that involve the blocked user if they're a bot, or any of their bots if they're a human. Edits run only for challenges with `botPlayers < 2`. The blocked human's own pending challenges behave as they do today.
- Produces: `GroupSettingsDto.bots: PlayerRef[]` (the group's bots, with `displayName` labels and `blocked: boolean`). Use the existing `PlayerRef` shape plus a `blocked` flag, the way the `blocked` list is built today.
- **UI:** `GroupSettings.tsx` shows a "Bots" section listing `bots`, each with the same block/unblock control the screen uses for people. Copy: `app.group_settings.bots` is "Bots", and `app.group_settings.bots_empty` is "No bots in this group."

- [ ] **Step 1: Write the failing tests** (`bot-groups.test.ts`):
  - `an owner adds their bot to a group they're in`: the bot then has a `member` row, and `assertBotMayPlay` passes.
  - `refuses when the owner isn't a member`: `owner_not_member`.
  - `refuses when the owner is blocked, and when the bot is blocked`: both give `blocked`.
  - `refuses someone else's bot`: `bot_not_found`.
  - `assertBotMayPlay fails once the owner leaves`: after `markLeft(owner)` it throws `owner_not_member`.
  - `blocking the owner blocks their bots`: `isBlocked(bot)` is true after `adminBlock(owner)`, and false again after `adminUnblock`.
  - `blocking cancels the bots' pending challenges but not live games`: a bot with one pending human→bot challenge (`botPlayers 1`), one pending bot→bot challenge (`botPlayers 2`) and an active game. After `adminBlock(owner)`, both challenges are settled. Exactly one `edit_card` job is enqueued, for the `botPlayers 1` challenge. The game is still active.
  - `removing a bot from a group cancels its challenges there`.
  - `groupSettingsDto lists the group's bots with their blocked state`.
  - Mini App: the Bots section renders the bots, and blocking one sends `POST /api/groups/:g/blocks { userId }`.
- [ ] **Step 2: Run them to see them fail.** `cd apps/server && pnpm exec vitest run test/integration/bot-groups.test.ts`, and `cd apps/miniapp && pnpm exec vitest run test/groupSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the module, the changes to `isBlocked` and `adminBlock`, the DTO and the UI.
- [ ] **Step 4: Run them to see them pass.** Same commands, plus `test/integration/users-groups.test.ts` and any admin tests (`grep -l adminBlock apps/server/test -r`). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: put bots in groups; blocks cover bots and their owners"`

### Task 3: Challenge rules for bots

**Files:**
- Modify: `apps/server/src/domain/challenges.ts` (`createChallenge`, `acceptChallenge`, `declineChallenge`, `cancelChallenge`, `expireChallenges`, `createRematch`)
- Modify: `apps/server/src/telegram/cards.ts` and `apps/server/src/telegram/views.ts` (the challenge card for a bot opponent)
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `apps/server/test/integration/bot-challenges.test.ts` (create)

**Interfaces:**
- Consumes: `assertBotMayPlay`, `isOwnedBot` and `countBotPlayers`.
- Produces: `createChallenge` sets `challenges.botPlayers`, and applies these rules after the existing validations, in this order:
  1. The challenger is a bot and the opponent is missing, a username, or not a bot: `bots_challenge_bots_only`.
  2. Every bot involved passes `assertBotMayPlay`.
  3. `botPlayers === 1 && timePerMove === null`: `bot_games_need_clock`.
  4. Both sides are bots with the same owner, or one side is the other's owner: force `rated = false`.
  5. If `botPlayers === 2`, no `send_challenge_card` and no DM. If `botPlayers === 1`, the card is posted and no DM goes to the bot.
- Produces: `acceptChallenge` re-checks `assertBotMayPlay` for every bot on either side (Review Focus 2). `declineChallenge`, `cancelChallenge` and `expireChallenges` enqueue no `edit_card` and retire no DM when `botPlayers === 2`.
- Produces: `createRematch` keeps working for human-vs-bot. A rematch request that would make a bot challenge a human is refused by rule 1. A rematch of a bot-vs-bot game goes through the same rules.
- **Card:** a direct challenge whose opponent is a bot shows only the challenger's **Cancel** button and the lobby link. There is no Accept, and no Decline for others to tap. The text is the existing `card.challenge.direct`, followed by a second line from Task 7. Until Task 7 lands, the second line is omitted.

- [ ] **Step 1: Write the failing tests** (`bot-challenges.test.ts`, using `insertBot` and `addBotToGroup` from Task 2):
  - `a human challenges a bot`: a `send_challenge_card` job and no `send_dm` job; `botPlayers === 1`.
  - `refuses a clockless human→bot challenge`: `bot_games_need_clock`.
  - `a bot challenges a bot silently`: `botPlayers === 2`, and the jobs table has no card or DM job. `timePerMove: null` is accepted.
  - `bots never challenge humans`: a bot→human challenge, a bot open challenge and a bot username challenge all give `bots_challenge_bots_only`.
  - `refuses a bot not in the group, and a bot whose owner left`: `bot_not_in_group` and `owner_not_member`.
  - `same-owner games are casual`: owner→own bot with `rated: true` is stored `rated: false`, and so is bot→sibling bot.
  - `accept is refused when the owner left after the challenge was made`: `owner_not_member`, and the challenge stays pending.
  - `a bot accepts a human's challenge`: `acceptChallenge({ userId: bot.id })` creates the game. The game's `botPlayers` equals the challenge's.
  - `bot-vs-bot decline, cancel and expiry enqueue no card or DM jobs`.
  - `the challenge card for a bot opponent has no Accept or Decline`: render it and assert the button callback data contains only the cancel action and the lobby link.
- [ ] **Step 2: Run them to see them fail.** `cd apps/server && pnpm exec vitest run test/integration/bot-challenges.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rules and the card change.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `test/integration/challenges.test.ts test/integration/telegram-handlers.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: challenge rules — humans challenge bots, bots challenge bots, never humans"`

### Task 4: Game side effects and listing

**Files:**
- Modify: `apps/server/src/domain/challenges.ts` (the game insert in `acceptChallenge`)
- Modify: `apps/server/src/domain/games.ts` (`commitOne`, the post-move side effects, `finishGame`, `endGameDms`, `voidGame`)
- Modify: `apps/server/src/domain/lobby.ts` (`activeGames`, `listFinished`)
- Test: `apps/server/test/integration/bot-games.test.ts` (create)

**Interfaces:**
- Consumes: `games.botPlayers` (Task 1).
- Produces these rules:
  - **`botPlayers === 2`:**
    - no `edit_card`, `send_result_photo`, `send_dm` or `markWaiting` DM, and no reminder (`reminderAt` null);
    - draw offers and claims, resignation and abort work as normal;
    - Lichess import works as for any game.
  - **`botPlayers === 1`:**
    - cards, card edits and result photos as for human games;
    - DMs and reminders only for the human side; `reminderAt` is computed as if the bot side had DMs off.
  - **Lobby:** `activeGames` and `listFinished` exclude `botPlayers = 2`. `meGames` and `playerPage` are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `a bot-vs-bot game posts nothing`: play a few moves with `playMove` as each bot, then resign. The jobs table has no `edit_card`, `send_result_photo` or `send_dm`, and the game has `reminderAt` null throughout.
  - `a human-vs-bot game edits the card and posts a result photo, and DMs only the human`: after the bot moves, there is a `send_dm` turn job for the human. After the human moves, there is no DM job for the bot. On finish there is one `send_result_photo` job.
  - `the lobby leaves out bot-vs-bot games but lists human-vs-bot ones`: test both `activeGames` and `listFinished`.
- [ ] **Step 2: Run them to see them fail.** `cd apps/server && pnpm exec vitest run test/integration/bot-games.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, branching on `game.botPlayers`, plus the opponent's `isOwnedBot` where the DM target is chosen.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `test/integration/games.test.ts test/integration/dm-messages.test.ts test/integration/result-photo.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: bot-vs-bot games stay out of the chat and the lobby"`

### Task 5: Abort stale clockless bot-vs-bot games

**Files:**
- Modify: `apps/server/src/clock/scanners.ts`
- Modify: `apps/server/src/domain/limits.ts` (`STALE_BOT_GAME_DAYS = 30`)
- Test: `apps/server/test/integration/scanners.test.ts`

**Interfaces:**
- Produces: `abortStaleBotGames(deps: Deps, limit = 100): Promise<number>`. It selects `FOR UPDATE SKIP LOCKED` active games with `bot_players = 2`, `time_per_move is null` and `coalesce(last_move_at, started_at) < now() - interval '30 days'`. It finishes each one through `finishGame` with result `*` and end reason `abort`, then publishes the bus after commit.
- Produces: `runScannersOnce` returns `{ forfeits, reminders, expiries, staleBotGames }`.

- [ ] **Step 1: Write the failing tests:**
  - `aborts a clockless bot-vs-bot game idle for over 30 days`: set `lastMoveAt` to now minus 30 days minus 1 minute. The game ends `*` with `abort`, and its rating columns stay null.
  - `leaves one idle for 29 days`.
  - `uses startedAt when nobody has moved`.
  - `never touches clocked bot-vs-bot games or human games`.
  - `runScannersOnce reports staleBotGames`.
- [ ] **Step 2: Run them to see them fail.** `cd apps/server && pnpm exec vitest run test/integration/scanners.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: abort clockless bot-vs-bot games idle for 30 days"`

### Task 6: Bot rating pool

**Files:**
- Modify: `packages/shared/src/rating/replay.ts` (`RatedGameRecord`, `applyRatedGame`, `replayRatings`)
- Modify: `apps/server/src/domain/ratings.ts` (`applyGameResultToRatings`, `rebuildGroupRatings`, `upsertStates`, `snapshotColumns`)
- Test: `packages/shared/test/rating*.test.ts` (extend the existing replay test file), `apps/server/test/integration/ratings.test.ts`

**Interfaces:**
- Produces: `RatedGameRecord` gains `frozen?: 'white' | 'black'`. In `applyRatedGame`, the frozen side's state is read (inflated for inactivity as usual) but **not mutated**: no rating, RD, volatility, counters or `lastRatedGameAt` change. The snapshot's frozen side has `before` equal to `after`.
- Produces: `applyGameResultToRatings` for `game.botPlayers === 1` sets `frozen` to the human's colour. It never upserts the human's state, and it writes **null** for the human side's four snapshot columns. Readers already fall back to the live rating when a side's snapshot is incomplete, so a human never sees a change from a bot game. `rebuildGroupRatings` produces the same results: its query must know which colour is the human in each `bot_players = 1` game (join users on `owner_id`).

- [ ] **Step 1: Write the failing tests:**
  - Shared: `a frozen side's state is untouched`. Replay a game with `frozen: 'black'`: black's state is deep-equal to its input, and white's changes as it would without `frozen`.
  - Server: `a rated human-vs-bot game moves only the bot`. Finish a rated human-vs-bot game: the human has no `ratings` row (or an unchanged one, if they had one), the bot's row changes, and the human side's snapshot columns are null.
  - Server: `rated bot-vs-bot updates both bots`.
  - Server: `rebuild matches incremental` (Review Focus 3). Finish a human-vs-human game, a rated human-vs-bot game and a bot-vs-bot game. Record every `ratings` row, then run `rebuildGroupRatings` and assert identical rows. Then void the human-vs-bot game, rebuild, and assert the human's row equals what a group with only the human-vs-human game would give.
- [ ] **Step 2: Run them to see them fail.** `cd packages/shared && pnpm exec vitest run test/<rating replay file>`, and `cd apps/server && pnpm exec vitest run test/integration/ratings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Same commands, plus all shared tests (`cd packages/shared && pnpm exec vitest run`). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: bot rating pool; human ratings never move in bot games"`

### Task 7: Bot activity

**Files:**
- Modify: `apps/server/src/domain/bots.ts` (`touchBotActivity`)
- Modify: `apps/server/src/domain/players.ts` (`toPlayerRef`) and `packages/shared/src/protocol/dto.ts` (`PlayerRefSchema`)
- Modify: `apps/server/src/telegram/views.ts` and `apps/server/src/telegram/cards.ts` (the activity line on challenge cards to a bot)
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: the Mini App's player rows and player bar, which show the activity for bots: `apps/miniapp/src/ui/rows.tsx` and `apps/miniapp/src/ui/game/PlayerBar.tsx`
- Test: `apps/server/test/integration/bots.test.ts`, `apps/server/test/unit/` (card rendering, if a card unit test exists; otherwise integration), and `apps/miniapp/test/player.test.tsx` or the closest existing test for `PlayerBar`/rows

**Interfaces:**
- Produces: `touchBotActivity(tx: DbOrTx, botId: number): Promise<void>`. It sets `users.last_active_at = now()` only when the value is null or older than 60 s. It never touches humans or the engine. Milestone 3 calls it on every tool call naming a bot.
- Produces: `PlayerRef.botActivity: { lastActiveAt: string | null } | null`. It is non-null only for owned bots. It is read from `users.last_active_at` (Task 1). A bot that has never been active gets `lastActiveAt: null`.
- **Copy** (exact):
  - `card.challenge.bot_active_now`: "{bot} is active now."
  - `card.challenge.bot_last_active`: "{bot} was last active {ago} ago."
  - `card.challenge.bot_never_active`: "{bot} hasn't been active yet."
  - `app.player.bot_active_now`: "Active now"
  - `app.player.bot_last_active`: "Last active {ago} ago"
  - `app.player.bot_never_active`: "Not active yet"
  - `{ago}` uses whatever compact duration formatter the codebase already has for clocks (e.g. `3h`, `2d`). Reuse it; don't add a new one.

- [ ] **Step 1: Write the failing tests:**
  - `touchBotActivity writes at most once a minute`.
  - `touchBotActivity ignores humans`.
  - `toPlayerRef gives bots botActivity and humans null`.
  - `the challenge card to an idle bot says when it was last active`. A bot last active 3 days ago gives a second line matching `card.challenge.bot_last_active` with `3d`, and a just-touched bot gives `card.challenge.bot_active_now`.
  - Mini App: a bot's player row shows "Last active 3d ago", and a human's shows no activity.
- [ ] **Step 2: Run them to see them fail.** Run the files above. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Same files, then the full `pnpm test` at the root, plus `pnpm lint`, `pnpm format:check` and `pnpm typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: track and show bot activity"`

## Deferred to later milestones (not in this plan)

- The idle-bot warning before a human sends a challenge belongs to the bot browser in New Game (#110, milestone 4). Until then humans reach bots only through rematch buttons and API calls, so there's nowhere to show it. Note this on #101 when closing it.
- Calls to `touchBotActivity` and `acceptChallenge` as a bot come from the MCP tools (milestone 3).
- Bot standings and the Bots tab belong to milestone 4.
