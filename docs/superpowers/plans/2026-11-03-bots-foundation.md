# Bots 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot accounts exist as labelled, non-human `users` rows owned by a human. Owners can create, rotate and revoke an owner token in the app. Bots are kept out of human-only features, and deleting a bot or its owner works. This covers milestone "Bots 1: foundation", issues #92–#95.

**Architecture:** A bot is a `users` row with `owner_id` set, no Telegram id and `is_engine = false`. The owner's display name is copied onto the bot as `owner_name` and refreshed whenever the owner is seen. That way `displayName(user)` can return the full label ("🤖 Deep Goat (@jo)") without a join, and every existing caller of `displayName` labels bots for free. Owner tokens live in their own table and are stored hashed. This milestone creates and stores them; nothing accepts them yet, because the MCP server that will is milestone 3. Bot management is domain functions only. The MCP tools in milestone 3 call them, and the app gets no management screens.

**Tech Stack:** TypeScript, Node 22, Hono, drizzle-orm 0.45 and drizzle-kit, PostgreSQL 18, zod 4, Preact (Mini App), vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-bot-accounts-design.md` (§1 Identity and tokens, §8 Deletion, §9 Audit).

## Global Constraints

- **An agent never acts as a human.** No code path in this milestone may let an owner token authenticate any existing route. Session middleware stays session-only.
- **Owner token format:** the prefix `cgbot_` followed by 32 random bytes in base64url. Store only the SHA-256 hash. Show the token once, at creation.
- **One token per owner.** Creating a token replaces any existing one. Revoking it deletes it.
- **Bot names:** 1–32 characters after trimming and collapsing runs of spaces to one. Letters, digits, spaces, `.`, `_` and `-` are allowed, and the first character must be a letter or digit. Names are unique case-insensitively among live bots. `Stockfish`, `Deleted player` and `Deleted bot` are reserved (case-insensitively).
- **Tagline:** optional, at most 80 characters, one line (no line breaks).
- **At most 20 live bots per owner** (`MAX_BOTS_PER_OWNER = 20` in `apps/server/src/domain/limits.ts`).
- **Only a live human can own bots:** not the engine, not a bot, not deleted, and with a Telegram id.
- **Label:** a live bot is shown as `🤖 {name} ({ownerName})`, where `ownerName` is the owner's `displayName` (`@handle`, or first name if they have no handle). The label never adds the word "bot"; the emoji says it. A deleted bot is shown as `🤖 Deleted bot`.
- **Bots earn and wear no flair.** A game with a bot on either side awards no flair to anyone.
- **Usage stats:** bots never count as users in `stats.users`.
- **Run commands with Node on PATH:** `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`. Integration tests need local Postgres (`scripts/local-postgres.sh start`; see `docs/testing.md`).

## Review Focus

1. **An owner changes their Telegram handle.** Every bot they own should show the new handle the next time the owner is seen. Test in Task 2.
2. **Bot names that differ only in case or spacing**, e.g. `Deep  Goat` and `deep goat`, are the same name. The second is refused as taken, including when two creates race each other. Test in Task 3.
3. **A token pasted with whitespace or a trailing newline, a session JWT, or random junk sent as an owner token** resolves to no user. It never throws. Test in Task 4.
4. **An owner deletes their data while their bot is mid-game against a human.** The human wins by resignation, the bot shows as "🤖 Deleted bot", and the token stops resolving. Test in Task 8.
5. **A deleted bot's name and slot become free.** An owner at the limit who deletes a bot can create another, and can reuse the deleted bot's name. Test in Task 8.

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/server/src/db/schema.ts` (the `users` table; a new `ownerTokens` table)
- Create: `apps/server/drizzle/0015_bot_accounts.sql` (generated, then the stats views appended by hand), plus the drizzle `meta` files that generation updates
- Modify: `apps/server/test/integration/stats-views.test.ts`
- Modify: `docs/operations.md`, and the usage-dashboard section that lists the stats views, if it names their columns

**Interfaces:**
- Produces: `users.ownerId: number | null` (FK to `users.id`, no cascade), `users.ownerName: string | null`, `users.tagline: string | null`; `ownerTokens` table `{ userId (PK, FK users.id ON DELETE CASCADE), tokenHash: Buffer (bytea, unique), createdAt, lastUsedAt: Date | null }`; `type OwnerTokenRow`.
- Index `users_owner_id` on `owner_id`.
- Unique index `users_bot_name` on `lower(first_name)` where `owner_id is not null and deleted_at is null`.
- Check constraint `users_bot_shape`: `owner_id is null or (telegram_user_id is null and not is_engine)`.

- [ ] **Step 1: Update the stats-views test first.** Add `vs_bot` as the last column of `VIEWS.games`, and add `bots: ['id', 'created_at', 'deleted']`. Extend `counts people, leaving out the engine…` so it also inserts a bot (owner set, no Telegram id) and asserts the bot's id is not in `stats.users`. Extend `classifies games` with a human-vs-bot game and assert that `ids('vs_bot')` equals exactly that game. Add `it('lists bots without names or owners', …)`: insert two bots, one deleted, and assert `select id, deleted from stats.bots` returns both with the right `deleted` flags.
- [ ] **Step 2: Run it to see it fail.** `pnpm --filter @chess-goat/server test -- test/integration/stats-views.test.ts`. Expected: FAIL (`owner_id` does not exist).
- [ ] **Step 3: Add the columns, the table, the indexes and the check to `schema.ts`.** Run `pnpm --filter @chess-goat/server db:generate` to generate `0015_bot_accounts.sql`, and rename the file if drizzle chose another name, keeping the journal in step. Then append by hand, after a `--> statement-breakpoint`:
  - `create or replace view stats.users`, with `AND "u"."owner_id" IS NULL` added to the `WHERE`;
  - `create or replace view stats.games`, appending `EXISTS (… "b"."owner_id" IS NOT NULL AND "b"."id" IN ("g"."white_id","g"."black_id")) AS "vs_bot"` as the **last** column, because `create or replace` can only add columns at the end;
  - `create or replace view stats.bots as select id, created_at, deleted_at is not null as deleted from public.users where owner_id is not null`.

  Update `docs/operations.md`, and any list of stats views or columns, to mention `stats.bots` and `vs_bot`.
- [ ] **Step 4: Run it to see it pass.** Same command. Expected: PASS. Also run `pnpm --filter @chess-goat/server test -- test/integration/db.test.ts test/integration/migrate-reset.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bot accounts schema: owned bot users, owner tokens, stats views"`

### Task 2: Bot identity and labels

**Files:**
- Modify: `apps/server/src/domain/users.ts`
- Modify: `apps/server/test/helpers/fixtures.ts`
- Test: `apps/server/test/unit/users.test.ts` (extend it) and `apps/server/test/integration/bots.test.ts` (create)

**Interfaces:**
- Consumes: the Task 1 columns.
- Produces:
  - `isOwnedBot(user: Pick<UserRow, 'ownerId'>): boolean`
  - `isHuman(user: Pick<UserRow, 'isEngine' | 'ownerId'>): boolean`
  - `displayName(user: Pick<UserRow, 'firstName' | 'username' | 'deletedAt' | 'ownerId' | 'ownerName'>): string`
  - `wornFlair` and `Wearer` gain `'ownerId'`
  - Test fixture: `insertBot(db, owner: Pick<UserRow, 'id'> & Partial<Pick<UserRow,'username'|'firstName'>>, overrides?): Promise<UserRow>`. It inserts a bot named `Bot{n}` with `ownerName` set to the owner's display name.

- [ ] **Step 1: Write the failing tests.**
  - Unit `displayName`:
    - a bot `{firstName:'Deep Goat', ownerId:1, ownerName:'@jo'}` gives `"🤖 Deep Goat (@jo)"`;
    - a deleted bot gives `"🤖 Deleted bot"`;
    - a deleted human still gives `"Deleted player"`;
    - a human with a username still gives `"@x"`.
  - Unit `wornFlair`: a bot with `flairWorn: ['rank_1500']` returns `[]`.
  - Unit `isHuman`: false for `{isEngine:true}` and for `{ownerId:5}`, true otherwise.
  - Integration `bots.test.ts`, `refreshes owner labels when the owner is seen`: insert owner `{telegramUserId: 77, username: 'jo'}` and a bot via `insertBot`. Call `ensureUser(db, { telegramUserId: 77, firstName: 'Jo', username: 'joanna' })`. Assert the bot row's `ownerName` is `'@joanna'`. A second `ensureUser` with the same fields leaves the bot's `ownerName` unchanged, and the test checks this through the row.
  - Integration, `does not relabel deleted bots`: a deleted bot keeps its `ownerName`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/unit/users.test.ts test/integration/bots.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `displayName`: a bot with `deletedAt` set gives `'🤖 Deleted bot'`; a live bot gives `` `🤖 ${firstName} (${ownerName})` ``; humans are unchanged.
  - `ensureUser`: after the upsert, run `update users set owner_name = <displayName(row)> where owner_id = row.id and deleted_at is null and owner_name is distinct from <that>`.
  - Fix every compile error the wider `Pick`s cause by adding `ownerId` and `ownerName` to the narrow picks and explicit column selections. `pnpm -r exec tsc --noEmit` (or the repo's `pnpm check`) lists them. Callers that pass full rows need no change.
  - Add `insertBot` to `fixtures.ts`.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `pnpm --filter @chess-goat/server test -- test/integration/users-groups.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: label bots with their owner, refresh the label when the owner is seen"`

### Task 3: Bot management domain

**Files:**
- Create: `apps/server/src/domain/bots.ts`
- Modify: `apps/server/src/domain/limits.ts` (`MAX_BOTS_PER_OWNER = 20`)
- Test: `apps/server/test/integration/bots.test.ts`

**Interfaces:**
- Consumes: `isHuman` and `displayName` (Task 2).
- Produces (all in `domain/bots.ts`):
  - `normaliseBotName(raw: string): string`. It trims and collapses runs of spaces.
  - `createBot(tx: DbOrTx, ownerId: number, input: { name: string; tagline?: string | null }): Promise<UserRow>`
  - `updateBot(tx: DbOrTx, ownerId: number, botId: number, patch: { name?: string; tagline?: string | null }): Promise<UserRow>`
  - `listBots(tx: DbOrTx, ownerId: number): Promise<UserRow[]>`. Live bots only, oldest first.
  - `requireOwnBot(tx: DbOrTx, ownerId: number, botId: number): Promise<UserRow>`. A missing bot, a deleted bot, or someone else's bot all give `not_found`, so callers can't learn whether another owner's bot exists.
- `DomainError` codes (from `ERROR_CODES` in `packages/shared/src/protocol/errors.ts`) and `reason` values:
  - `validation` / `invalid_bot_name`
  - `validation` / `invalid_tagline`
  - `validation` / `bot_name_taken`
  - `forbidden` / `not_a_human_owner`
  - `limit_exceeded` / `too_many_bots`, with `limit: 20` in the details
  - `not_found` / `bot_not_found`

- [ ] **Step 1: Write the failing tests** in `bots.test.ts`:
  - `creates a bot with no Telegram id and its owner's label`. It asserts `ownerId`, `ownerName === '@jo'`, `telegramUserId === null`, `isEngine === false`, and that `displayName(bot)` is `"🤖 Deep Goat (@jo)"`.
  - `normalises names`. `'  Deep   Goat '` is stored as `'Deep Goat'`.
  - `refuses invalid names`. Each of `''`, `'   '`, a 33-character name, `'@goat'`, `'-goat'`, `'goat!'` and `'stockfish'` throws `invalid_bot_name`.
  - `refuses taken names case-insensitively`. `'Deep Goat'` then `'deep  goat'` (from another owner) throws `bot_name_taken`.
  - `refuses a taken name when two creates race`. Two concurrent `createBot` calls with the same name: exactly one resolves, the other throws `bot_name_taken` and never a raw unique-violation error.
  - `refuses taglines over 80 characters or with line breaks`. Throws `invalid_tagline`.
  - `allows 20 bots and refuses the 21st`. Throws `too_many_bots`.
  - `only humans own bots`. A bot owner, the engine, a deleted user, and a user with no Telegram id each throw `not_a_human_owner`.
  - `updates name and tagline, and only for the owner`. Another owner's `updateBot` throws `bot_not_found`. Renaming to a taken name throws `bot_name_taken`. Renaming to the bot's own name in another case succeeds.
  - `lists live bots oldest first`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/integration/bots.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `domain/bots.ts` and the limit.**
  - Validate names with the Unicode-aware pattern `/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u` after normalising.
  - Translate a unique violation on `users_bot_name` (Postgres `23505`) into `bot_name_taken`.
  - Count live bots for the limit while holding a `FOR UPDATE` lock on the owner row, so concurrent creates can't overshoot.
- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: create, rename, retag and list an owner's bots"`

### Task 4: Owner tokens domain

**Files:**
- Create: `apps/server/src/domain/ownerTokens.ts`
- Test: `apps/server/test/integration/owner-tokens.test.ts`

**Interfaces:**
- Consumes: `isHuman` (Task 2).
- Produces:
  - `OWNER_TOKEN_PREFIX = 'cgbot_'`
  - `createOwnerToken(tx: DbOrTx, userId: number): Promise<string>`. It returns the plaintext token and replaces any existing one. A user who isn't a live human gets `forbidden` / `not_a_human_owner`.
  - `revokeOwnerToken(tx: DbOrTx, userId: number): Promise<void>`. Idempotent.
  - `ownerTokenStatus(tx: DbOrTx, userId: number): Promise<{ createdAt: Date; lastUsedAt: Date | null } | null>`
  - `resolveOwnerToken(tx: DbOrTx, presented: string): Promise<UserRow | null>`. It trims the input. It returns null for a missing prefix, wrong length, unknown hash, or a deleted owner. On success it updates `lastUsedAt`, at most once a minute.

- [ ] **Step 1: Write the failing tests:**
  - `creates a prefixed token that resolves to its owner`. Asserts `/^cgbot_[A-Za-z0-9_-]{43}$/`, and that the stored `tokenHash` is not the token bytes.
  - `rotating replaces the old token`. The old token resolves to null and the new one resolves.
  - `revoking stops resolution, and revoking twice is fine`.
  - `resolves a token with surrounding whitespace or a trailing newline`.
  - `rejects junk without throwing`: `''`, `'cgbot_'`, `'cgbot_short'`, a session JWT from `issueSessionToken`, and 10 KB of `'a'`.
  - `stops resolving once the owner is deleted`: set `deletedAt` directly.
  - `refuses tokens for bots and the engine`.
  - `ownerTokenStatus` reports `createdAt`, and `lastUsedAt` after a resolve.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/integration/owner-tokens.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.randomBytes(32)` for the token and `crypto.createHash('sha256')` for the hash. Look tokens up by hash with an indexed equality match. A hash lookup needs no constant-time comparison.
- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Owner tokens: create, rotate, revoke and resolve, stored hashed"`

### Task 5: Owner token API

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (`OwnerTokenStatusDtoSchema`, `OwnerTokenCreatedDtoSchema`)
- Modify: `apps/server/src/api/routes/me.ts`
- Test: `apps/server/test/integration/api-owner-token.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `GET /api/me/owner-token` returns `OwnerTokenStatusDto = { token: { createdAt: string; lastUsedAt: string | null } | null }`.
  - `POST /api/me/owner-token` (empty body) returns `OwnerTokenCreatedDto = { token: string; createdAt: string }`. It is rate-limited with a `RateLimiter(5, 60_000)` keyed per user.
  - `DELETE /api/me/owner-token` returns `OkDto`.

- [ ] **Step 1: Write the failing tests** using `startTestApi` and `sessionFor`:
  - `GET` before any token gives `{ token: null }`.
  - `POST` returns a `cgbot_` token, and `GET` then reports `createdAt`.
  - A second `POST` rotates: the first token no longer resolves via `resolveOwnerToken`.
  - `DELETE` revokes.
  - A sixth `POST` within a minute gets `rate_limited` (HTTP status from `HTTP_STATUS_BY_ERROR_CODE`).
  - **The token is not a session:** `GET /api/me/groups` with `Authorization: Bearer <owner token>` is rejected with the same status as an invalid session.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/integration/api-owner-token.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the DTO schemas and the three routes** in `meRoutes`.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `test/integration/api-auth.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Owner token API under /me"`

### Task 6: Mini App "Bots" screen with the token card

**Files:**
- Modify: `apps/miniapp/src/router.ts` (add the route `{ name: 'bots' }`)
- Modify: `apps/miniapp/src/ui/App.tsx`
- Modify: `apps/miniapp/src/ui/screens/Settings.tsx` (a "Bots" row after Move confirmations)
- Create: `apps/miniapp/src/ui/screens/Bots.tsx`
- Modify: `packages/shared/src/i18n/en.ts` (`app.settings.bots`, `app.bots.*`)
- Test: `apps/miniapp/test/bots.test.tsx`, and `apps/miniapp/test/settings.test.tsx` for the new row

**Interfaces:**
- Consumes: the Task 5 routes and DTOs.
- Produces: the `bots` route. Milestone 4's owner dashboard extends this screen.

**Copy** (exact text, add it to `en.ts`):
- `app.settings.bots`: "Bots"
- `app.bots.title`: "Your bots"
- `app.bots.intro`: "Bots are chess players that your AI agent runs. Connect an MCP client such as Claude Code to Chess Goat with your owner token, then ask it to create a bot."
- `app.bots.token`: "Owner token"
- `app.bots.token_none`: "No token yet."
- `app.bots.token_created`: "Created {date}"
- `app.bots.token_last_used`: "Last used {date}"
- `app.bots.token_never_used`: "Never used"
- `app.bots.create`: "Create token"
- `app.bots.rotate`: "Replace token"
- `app.bots.revoke`: "Revoke token"
- `app.bots.warning`: "This token can create, change and delete your bots and play as any of them. It can never act as you. Keep it secret."
- `app.bots.shown_once`: "Copy it now. It won't be shown again."
- `app.bots.copy`: "Copy"
- `app.bots.copied`: "Copied"
- `app.bots.rotate_confirm`: "Replace your token? Anything using the old one stops working."
- `app.bots.revoke_confirm`: "Revoke your token? Anything using it stops working."

- [ ] **Step 1: Write the failing tests** (`bots.test.tsx`, using `renderApp` and fake routes as in `settings.test.tsx`):
  - With `{ token: null }` it shows `app.bots.token_none`, the warning, and a `[data-action="create-token"]` button.
  - Clicking create sends `POST /api/me/owner-token`. It shows the returned token in `[data-token]` with `app.bots.shown_once` and a `[data-action="copy-token"]` button. Clicking copy calls `navigator.clipboard.writeText(token)` and toasts `app.bots.copied`.
  - With an existing token it shows the created and last-used lines, plus `[data-action="rotate-token"]` and `[data-action="revoke-token"]`. Both actions confirm first, and cancelling sends nothing.
  - Revoke sends `DELETE` and goes back to the none state.
  - A failed request toasts `app.common.error`.
  - The token is gone after leaving and reopening the screen: it's held only in component state.
  - `settings.test.tsx`: a `[data-action="bots"]` row pushes `{ name: 'bots' }`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/miniapp test -- test/bots.test.tsx test/settings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, the screen and the Settings row, following `Settings.tsx`'s card and row classes and dialog helpers.
- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Mini App: Bots screen with the owner token"`

### Task 7: Keep bots out of human-only features

**Files:**
- Modify: `apps/server/src/flair/award.ts`, `apps/server/src/flair/history.ts` (`COUNTED`, and the award path's counted check), `apps/server/src/flair/backfill.ts`, `apps/server/src/flair/profile.ts` (`setWornFlair`)
- Modify: `apps/server/src/domain/ratings.ts` (`getLeaderboard`)
- Modify: `apps/server/src/domain/members.ts` (`listKnownPlayers`)
- Test: `apps/server/test/integration/bots.test.ts` (a `describe('bots are not people')` block)

**Interfaces:**
- Consumes: `isHuman` and `insertBot` (Task 2).
- Produces: no new signatures.

Leave these alone: they are already safe for bots, and Task 2's label covers how they show names. Note each one in the PR description:
- DM sending: `sendDm` needs `wantsDms` and a Telegram id.
- Photo fetching: needs a Telegram id.
- Telegram mentions: there's no username or id.
- Membership and admin checks: they need a Telegram id.
- `StreamGate` and sessions: bots can't launch.
- PGN, Lichess, share-image and card names: they go through `displayName`.

Bot game DMs and rating pools belong to milestone 2.

- [ ] **Step 1: Write the failing tests:**
  - `awards no flair for a game against a bot`. A finished, decided, rated human-vs-bot game run through the award job awards neither player any flair.
  - `the backfill ignores games against bots`. Run the backfill with such a game present and nothing is awarded for it.
  - `a bot cannot wear flair`. `setWornFlair` for a bot is refused, and `wornFlair` returns `[]`.
  - `the leaderboard leaves bots out`. A bot with a `ratings` row and `gamesPlayed > 0` is not in `getLeaderboard`.
  - `the opponent picker leaves bots out`. A bot with a `group_members` row is not in `listKnownPlayers`.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/integration/bots.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Exclude games with a bot on either side from `COUNTED` with a `not exists` on `users.owner_id`, and apply the same rule wherever the award job decides a game counts. If `isCountedGame` can't see the players, check the two player rows in the award handler; it already loads them.
  - In `award.ts`, skip when `!isHuman(player)`.
  - In `backfill.ts`, add `isNull(users.ownerId)`.
  - In `setWornFlair`, refuse non-humans.
  - In `getLeaderboard` and `listKnownPlayers`, add `isNull(users.ownerId)`.
- [ ] **Step 4: Run them to see them pass.** Same command, plus `test/integration/flair-award.test.ts test/integration/flair-backfill.test.ts test/integration/ratings.test.ts test/integration/users-groups.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: no flair, no leaderboard, not in the opponent picker"`

### Task 8: Deleting bots and owners

**Files:**
- Modify: `apps/server/src/domain/account.ts`
- Modify: `apps/server/src/domain/bots.ts` (`deleteBot`)
- Test: `apps/server/test/integration/bots.test.ts` (`describe('deletion')`), and `apps/server/test/integration/account.test.ts`

**Interfaces:**
- Consumes: `requireOwnBot` (Task 3) and `revokeOwnerToken` (Task 4).
- Produces: `deleteBot(deps: Deps, ownerId: number, botId: number): Promise<void>`, which milestone 3's `delete_bot` tool will call. Inside `account.ts`, factor the "resign live games, settle pending challenges, retire DMs, collect game ids to publish" steps of `deleteMyData` into a helper both use. Its signature is the builder's choice, but it must run in the caller's transaction, and publishing must happen after commit.

- [ ] **Step 1: Write the failing tests:**
  - `deleteBot resigns live games and settles challenges`. A bot playing white against a human ends `0-1` by resignation. A pending challenge from the bot is `cancelled`, and one to the bot is `declined`. `edit_card` jobs are queued as `deleteMyData` queues them. The bus is published for the finished game.
  - `a deleted bot is anonymised and frees its name`. `firstName` becomes `'Deleted bot'` and `deletedAt` is set. `displayName` gives `'🤖 Deleted bot'`. The finished game still references the bot id. `createBot` with the old name now succeeds.
  - `a deleted bot frees its slot`. With 20 bots, delete one and create another, which succeeds.
  - `deleteBot refuses other owners' bots and already-deleted bots`. Both throw `bot_not_found`.
  - `deleting an owner deletes their bots and revokes their token` (`account.test.ts`). The owner's bot is mid-game against a human. After `deleteMyData(owner)`, the human has won by resignation, `displayName` of the bot is `'🤖 Deleted bot'`, `resolveOwnerToken(oldToken)` is null, and the `owner_tokens` row is gone.
- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @chess-goat/server test -- test/integration/bots.test.ts test/integration/account.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `deleteBot`: in one transaction, lock with `FOR UPDATE` in the order `deleteMyData` already uses (games, then challenges, then rows); run the shared helper; set `firstName = 'Deleted bot'`, `tagline = null` and `deletedAt = now`; publish after commit.
  - `deleteMyData`: inside its transaction, delete each of the user's live bots the same way, then revoke the token.
- [ ] **Step 4: Run them to see them pass.** Same command. Then run the whole suite with `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bots: delete a bot, and delete an owner's bots with their data"`
