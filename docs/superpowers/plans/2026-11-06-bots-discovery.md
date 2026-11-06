# Bots 4: Challenging and Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People in a group can find bots, challenge them, and watch them play:
- an "A bot" button on the `/challenge` prompt;
- a bot browser, also reachable from New Game;
- "Challenge 🤖 X" buttons on cards and bot pages;
- an owner-posted "Taking challenges" card;
- a Bots view per group, with live bot games you can watch, bot standings and recent results;
- bot profiles;
- an owner dashboard;
- an opt-in weekly bot round-up.

This covers milestone "Bots 4: challenging and discovery", issues #109–#115.

**Architecture:**
- **Navigation.** Telegram deep links gain two start-param kinds: `bots` (a group's bot browser) and `challengeBot` (New Game with a bot preselected). Group cards build these with `miniAppLink`.
- **New screens.** The Mini App gets a group **Bots screen** (opened from a "Bots" chip in the lobby, next to the leaderboard chip), a **bot browser** screen, and bot-aware versions of New Game, the player page and the Settings → Bots screen. The bot browser reuses `searchGroupBots`, the same paging `find_bots` uses.
- **New jobs.** The "Taking challenges" card and the weekly round-up are new job kinds. The round-up reschedules itself, like the daily prune job.

**Tech Stack:** TypeScript, Preact Mini App, Hono, grammY, drizzle-orm, zod 4, vitest (happy-dom for the Mini App).

**Spec:** `docs/superpowers/specs/2026-11-03-bot-accounts-design.md` §3 (cards for human→bot games), §5 (Challenging a bot) and §6 (Discovery).

## Global Constraints

- **No bot list, search or handle in the chat.** Picking a bot always happens in the Mini App, reached by a deep link.
- **Human-vs-bot challenges need a clock.** When a bot is selected, New Game hides "No clock", and defaults to the group's default time per move, or 3 days if that default is "No clock".
- **Activity warning.** Show one when the picked bot's `botActivity.lastActiveAt` is null, or more than **24 h** ago. Copy (exact): `app.new.bot_idle`: "{bot} hasn't been active for a while, so it may not answer. Challenges expire after 24 hours." The challenge can still be sent.
- **Bot-vs-bot play stays out of the chat and the lobby.** It appears only on the group Bots screen and on bot profiles.
- **The "Taking challenges" card is posted only by a human owner from the app,** never by MCP or an agent. Limit: **1 per bot per group per 24 h**. Error: `rate_limited`, reason `announce_limit`.
- **Weekly round-up:**
  - Off by default. A group admin setting `botRoundup: boolean` (default `false`) turns it on.
  - Posted **Mondays at 17:00 UTC** to each group with the setting on and at least one finished bot game in the past 7 days.
  - Never posted otherwise.
- **The bot browser** is server-paginated: 20 per page, keyset cursors, as `searchGroupBots` does. It lists the same bots `find_bots` does: live, unblocked member bots whose owner is an unblocked member.
- **Deep links** stay within Telegram's `startapp` rules: at most 64 characters from `[A-Za-z0-9_-]`.
- **Copy** for new strings is given in each task, exactly. Bots are always named with `displayName` (`🤖 Name (@owner)`).
- **Run commands with Node on PATH:** `export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH`. Postgres must be running on 54329. Single file: `cd apps/<pkg> && pnpm exec vitest run <file>`. Before each commit, at the root: `pnpm lint`, `pnpm format:check` and `pnpm typecheck`. Bundle budget: `pnpm build && pnpm check:budget` must pass in the last task.

## Review Focus

1. **A deep link to a bot that has left the group, been blocked or been deleted.** New Game opens without that bot preselected and shows `app.new.bot_unavailable`, "That bot isn't available in this group any more.". It never crashes. Test in Task 3.
2. **A human picks a bot while New Game's time is "No clock".** The time switches to the default clock and "No clock" disappears. Picking a human again restores it. Test in Task 3.
3. **Someone who isn't in the group opens a `bots` or `challengeBot` deep link.** They land on the existing `locked` screen, as for any group link. Test in Task 1.
4. **An owner taps "Post 'Taking challenges' card" twice.** The second tap is refused with a toast. Test in Task 6.
5. **A group with the round-up on and no bot games that week.** Nothing is posted, and next week's job is still scheduled. Test in Task 7.

---

### Task 1: Deep links: `bots` and `challengeBot`

**Files:**
- Modify: `packages/shared/src/protocol/startParam.ts` (+ tests in `packages/shared/test`)
- Modify: `packages/shared/src/protocol/dto.ts` (`LaunchRoute` gains `bots{group…}` and `newGame{…, opponentId?}`)
- Modify: `apps/server/src/api/launchRoute.ts`, `apps/miniapp/src/boot.ts` (`landingFor`), `apps/miniapp/src/router.ts` (new routes `groupBots{groupId}` and `botBrowser{groupId}`, and `newGame` stays `{groupId; opponentId?}`)
- Test: `apps/server/test/integration/api-launch*.test.ts` (whichever covers launch routes), and `apps/miniapp/test/boot.test.ts` / `launch.test.ts`

**Interfaces:**
- `StartParam` gains:
  - `{ kind: 'bots'; groupId }`, encoded `b_<groupId>`;
  - `{ kind: 'challengeBot'; groupId; botId: number }`, encoded `c_<groupId>_<botId base36>`.
- Decoding is strict. Anything malformed decodes to `null`, as today.
- `miniAppLink(config, { kind: 'bots', groupId })` and `miniAppLink(config, { kind: 'challengeBot', groupId, botId })`.
- Launch landing:
  - `bots` → the groups tab, with `[lobby]` below and `botBrowser{groupId}` on top.
  - `challengeBot` → `newGame{groupId, opponentId: String(botId)}`, with `[lobby]` below.
  - Both use the same membership check as `lobby`; a non-member gets `locked`.

- [ ] **Step 1: Write the failing tests:**
  - encode/decode round-trips for both kinds;
  - the longest possible `c_` param is at most 64 characters;
  - malformed params give `null`;
  - the launch route returns the new landing for a member and `locked` for a non-member (Review Focus 3);
  - `landingFor` builds the right stacks.
- [ ] **Step 2: Run them to see them fail.** `cd packages/shared && pnpm exec vitest run`, and the server and Mini App test files above. Expected: FAIL.
- [ ] **Step 3: Implement.** Add stub screens for the two new routes: a title, plus "Loading" on `botBrowser` and `groupBots`. Tasks 2 and 4 fill them in.
- [ ] **Step 4: Run them to see them pass.** Same commands. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Deep links to a group's bots and to challenging a bot"`

### Task 2: Bot browser (API and screen)

**Files:**
- Create: `apps/server/src/api/routes/bots.ts` (`GET /api/groups/:g/bots?q=&sort=&cursor=`; the requester must be a member)
- Modify: `packages/shared/src/protocol/dto.ts` (`BotListDto = { bots: BotCardDto[]; nextCursor: string | null }`, `BotCardDto = PlayerRef & { tagline: string | null; owner: string; gamesPlayed: number; record: WinDrawLoss }`)
- Create: `apps/miniapp/src/ui/screens/BotBrowser.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `apps/server/test/integration/api-bots.test.ts` (create), and `apps/miniapp/test/botBrowser.test.tsx` (create)

**Interfaces:**
- **Server:**
  - Wraps `searchGroupBots(tx, groupId, { query, sort, limit: 20, cursor })`.
  - The cursor format is the same as the MCP one. Move the encode/decode helpers from `mcp/tools/challenge.ts` to `domain/botGroups.ts` and use them in both places.
  - `sort` is `rating` (default), `active` or `newest`.
- **Screen:**
  - A search field, debounced 300 ms; three sort chips; and rows showing avatar, label, tagline, rating, record and activity (reuse `botActivityLabel`).
  - "Load more" when there's a cursor.
  - An empty state.
  - Tapping a row pushes `newGame{groupId, opponentId: bot.id}`.
- **Copy:**
  - `app.bots.browse_title`: "Bots in {group}"
  - `app.bots.search`: "Search bots"
  - `app.bots.sort_rating`: "Top rated"
  - `app.bots.sort_active`: "Most active"
  - `app.bots.sort_newest`: "Newest"
  - `app.bots.none`: "No bots here yet. Anyone can add one with an AI agent — see Settings → Bots."
  - `app.bots.more`: "Show more"

- [ ] **Step 1: Write the failing tests:**
  - The API pages 25 bots as 20 plus 5.
  - Search is case-insensitive, and `%` is treated literally.
  - Blocked bots and bots whose owner left are hidden.
  - A non-member gets 403.
  - The screen renders rows and loads more.
  - Typing searches after 300 ms.
  - Tapping a row navigates to New Game with the bot.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bot browser: search, sort and page a group's bots"`

### Task 3: New Game with bots

**Files:**
- Modify: `apps/miniapp/src/ui/screens/NewGame.tsx`, plus its test `apps/miniapp/test/newGame.test.tsx`
- Modify: `apps/server/src/api/routes/groups.ts` (`GET /api/groups/:g/bots/:id`, which returns one `BotCardDto` if the bot is findable in the group, and 404 otherwise)
- Modify: `packages/shared/src/i18n/en.ts`

**Interfaces:**
- `Selection` gains `{ kind: 'ownedBot'; bot: BotCardDto }`. The existing `'bot'` kind stays as the Stockfish engine.
- **The opponent section** gains a row "Bots in this group…" with a robot icon and a chevron. It pushes `botBrowser{groupId}`.
- **When `opponentId` doesn't match a human:**
  - New Game fetches `GET /api/groups/:g/bots/:id`. If it's found, the bot is preselected.
  - If not, there's no selection and the `app.new.bot_unavailable` notice shows (Review Focus 1).
- **When the selection is an owned bot:**
  - "No clock" is removed from the time tiles, and a null time switches to the default clock (Review Focus 2).
  - The rated switch works as for humans; the server forces casual for your own bot.
  - The idle warning shows per Global Constraints.
  - Submit posts the normal `ChallengeRequest` with the bot's id.
- **Copy:**
  - `app.new.bots_row`: "Bots in this group"
  - `app.new.bot_unavailable`: "That bot isn't available in this group any more."
  - `app.new.bot_idle` (from Global Constraints)
  - `app.new.own_bot_casual`: "Games against your own bot are always casual."

- [ ] **Step 1: Write the failing tests:**
  - Preselection from `opponentId` loads the bot.
  - A 404 shows the unavailable notice.
  - Picking a bot hides "No clock" and replaces a null time.
  - Switching back to a human restores "No clock".
  - The idle warning appears only for idle bots.
  - Your own bot shows the casual note and the rated switch is disabled.
  - Submit sends `opponentId` and a non-null time.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "New Game: pick a bot, with a clock and an idle warning"`

### Task 4: The group Bots screen

**Files:**
- Create: `apps/server/src/domain/botLobby.ts` (`buildBotLobby(deps, group, viewer): Promise<BotLobbyDto>`) and the route `GET /api/groups/:g/bots/lobby`
- Modify: `packages/shared/src/protocol/dto.ts` (`BotLobbyDto = { live: GameSummary[]; standings: LeaderboardEntry[]; recent: GameSummary[] }`)
- Create: `apps/miniapp/src/ui/screens/GroupBots.tsx`. Modify `apps/miniapp/src/ui/screens/Lobby.tsx` to add a "Bots" chip next to the leaderboard chip, which pushes `groupBots{groupId}`.
- Test: `apps/server/test/integration/bot-lobby.test.ts` (create), `apps/miniapp/test/groupBots.test.tsx` (create), and `apps/miniapp/test/lobby.test.tsx`

**Interfaces:**
- **`live`:** active games with `bot_players = 2` in the group, newest move first, at most 50.
- **`recent`:** finished, non-voided `bot_players = 2` games, at most 20.
- **`standings`:** bots in the group with `gamesPlayed > 0`, ranked like `getLeaderboard` (the same query, with bots instead of people), at most 50. Blocked bots, and bots whose owner is blocked, are excluded.
- Rows reuse `GameCard` and `PlayerRow`. Tapping a game opens the existing game screen, where non-players watch.
- A "Browse all bots" button pushes `botBrowser`.
- **Copy:**
  - `app.lobby.bots_chip`: "Bots"
  - `app.group_bots.title`: "Bots"
  - `app.group_bots.live`: "Playing now"
  - `app.group_bots.standings`: "Bot standings"
  - `app.group_bots.recent`: "Recent bot games"
  - `app.group_bots.browse`: "Browse all bots"
  - `app.group_bots.empty`: "No bot games yet."

- [ ] **Step 1: Write the failing tests:**
  - The DTO has only bot-vs-bot games, in the stated orders and limits.
  - Standings exclude people and blocked bots.
  - A non-member gets 403.
  - The lobby chip navigates to the Bots screen.
  - The screen renders all three sections and the empty state.
  - Tapping a live game opens the game screen.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "A Bots screen per group: live bot games, standings, recent results"`

### Task 5: Bot profiles, and "Challenge 🤖 X" on cards

**Files:**
- Modify: `apps/server/src/domain/lobby.ts` (`playerPage`). For a bot, the DTO gains `bot: { tagline: string | null; owner: string; lastActiveAt: string | null; isMine: boolean } | null`, and its `recentGames` include bot-vs-bot games. Also modify `packages/shared/src/protocol/dto.ts`.
- Modify: `apps/miniapp/src/ui/screens/Player.tsx`. For a bot it shows the owner, the tagline and activity. Its Challenge button opens New Game with the bot. It's hidden when the viewer is the bot's owner, who instead sees "Post 'Taking challenges' card" (Task 6).
- Modify: `apps/server/src/telegram/cards.ts` and `views.ts`. Every group card with exactly one bot side gets a "Challenge 🤖 Name" button linking to `challengeBot` for that bot. On a pending challenge card the button is left out, because the challenge is already that. The game card for an **active** human-vs-bot game also gets the bot activity line (reuse `botActivityLine`) while it's the bot's turn.
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `apps/server/test/integration/api-games.test.ts` or a new `bot-profile.test.ts`; card unit and integration tests; `apps/miniapp/test/player.test.tsx`

**Copy:**
- `button.challenge_bot`: "Challenge {bot}"
- `app.player.owner`: "Run by {owner}"
- `app.player.challenge_bot`: "Challenge"

- [ ] **Step 1: Write the failing tests:**
  - The page DTO for a bot has the `bot` block and includes bot-vs-bot games.
  - For a person, `bot` is null.
  - A finished human-vs-bot game card has the Challenge button with the right `startapp` link.
  - A bot-vs-bot game produces no card at all (unchanged).
  - An active human-vs-bot card shows the activity line on the bot's turn.
  - The Player screen shows the owner, tagline and activity, and Challenge navigates.
  - The owner doesn't see Challenge.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Bot profiles, and Challenge buttons on cards with a bot"`

### Task 6: The "Taking challenges" card

**Files:**
- Modify: `apps/server/src/jobs/types.ts` (job kind `send_bot_announce`) and `apps/server/src/jobs/handlers/telegram.ts` (a handler that sends the card into the group's card topic, using the same thread rules as challenge cards)
- Create: `apps/server/src/domain/botAnnounce.ts` (`announceBot(deps, { ownerId, botId, groupId }): Promise<void>`). It requires that the requester owns the bot, that the bot may play in the group (`assertBotMayPlay`), and the 24 h limit.
- Create: the table `bot_announcements(bot_id, group_id, posted_at)` via migration `0018_bot_announcements.sql` (PK `(bot_id, group_id)`, upserting `posted_at`). The limit is checked against it.
- Route: `POST /api/groups/:g/bots/:id/announce` (session, owner only)
- Modify: `apps/miniapp/src/ui/screens/Player.tsx` (the owner's button, and a toast on success or refusal)
- Test: `apps/server/test/integration/bot-announce.test.ts` (create), and the Player screen test

**The card (exact):**
- Text: `🤖 {botLabel} is taking challenges.`, followed by `"{tagline}"` on a second line if there is a tagline.
- Buttons: `[Challenge {bot}]` (a `challengeBot` link), then the lobby row.

**Copy:**
- `app.player.announce`: "Post 'Taking challenges' card"
- `app.player.announced`: "Posted to the group."
- `app.player.announce_limit`: "You can post this once a day per group."

- [ ] **Step 1: Write the failing tests:**
  - The owner posts and one job is queued.
  - The job sends the exact text and buttons.
  - A second post within 24 h gives `rate_limited`/`announce_limit` (Review Focus 4).
  - Someone who isn't the owner gets 404.
  - A bot not in the group gets `bot_not_in_group`.
  - The Player screen shows the button only to the owner and toasts.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the migration (prettier the generated meta), the domain function, the route, the job and the UI.
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Owners can post a 'Taking challenges' card for their bot"`

### Task 7: Weekly bot round-up

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (`GroupSettings.botRoundup: boolean`, default `false`, exposed in `GroupSettingsDto`) and `apps/miniapp/src/ui/screens/GroupSettings.tsx` (a switch)
- Create: `apps/server/src/jobs/handlers/botRoundup.ts` (job kind `bot_roundup`), plus `ensureBotRoundupScheduled(db)` called at jobs-role boot, next to `ensurePruneScheduled`
- Create: `apps/server/src/domain/botRoundup.ts` (`buildRoundup(tx, groupId, since: Date): Roundup | null`, null when there were no finished bot games since `since`)
- Test: `apps/server/test/integration/bot-roundup.test.ts` (create), and the GroupSettings test

**Interfaces:**
- **Scheduling:** the job runs at the next Monday 17:00 UTC. After running it re-enqueues itself for the following Monday 17:00 UTC (dedup key `bot_roundup`). It posts to every group with `botRoundup` on and a non-null roundup.
- **`Roundup`** = `{ topBot: { label, rating } | null; mostWins: { label, wins } | null; upset: { winner, loser, gap } | null; games: number }`.
  - `games` counts finished bot games in the window.
  - `mostWins` is the most wins by one bot in the window.
  - `upset` is the finished, decided game in the window with the largest pre-game rating gap where the lower-rated side won. It includes human-vs-bot games, using the bot's rating and the human's rating at the time; human ratings come from the same snapshot fallbacks the cards use.
  - `topBot` is the highest-rated bot in the group's bot standings.
- **Message (exact lines, each omitted when its value is null):**
  - `🤖 This week's bots in {group}`
  - `{games} bot games played.`
  - `Top bot: {label} ({rating})`
  - `Most wins: {label} ({wins})`
  - `Upset of the week: {winner} beat {loser} ({gap} points lower)`
  - Buttons: `[Bots]` (a `bots` link), then the lobby row.
- **Copy:**
  - `app.gsettings.bot_roundup`: "Weekly bot round-up"
  - `app.gsettings.bot_roundup_help`: "A message every Monday about the week's bot games. Off by default."

- [ ] **Step 1: Write the failing tests:**
  - `buildRoundup` with a set of games gives the expected fields.
  - No games gives null.
  - The job posts only to groups with the setting on and activity.
  - With no activity nothing is posted, and the next run is still scheduled (Review Focus 5).
  - The next-run time is the following Monday at 17:00 UTC, computed from fixed dates: a Sunday, a Monday at 16:59, and a Monday at 17:01.
  - The GroupSettings switch saves `botRoundup`.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Weekly bot round-up, off unless an admin turns it on"`

### Task 8: "A bot" on the `/challenge` prompt, and the owner dashboard

**Files:**
- Modify: `apps/server/src/bot/challengePrompt.ts` (`promptView` main view). The row becomes `[Anyone (success), A bot (url → miniAppLink(config, { kind: 'bots', groupId }))]`, with a second row `[Game settings]`. `promptView` therefore needs `config` and `groupPublicId`; thread them through `openPrompt` and the edits.
- Modify: `apps/server/src/bot/promptHandlers.ts` as needed. `promptStateFrom` must ignore the URL button.
- Modify: `apps/miniapp/src/ui/screens/Bots.tsx` (the dashboard above the token card)
- Create: `GET /api/me/bots` (session) returning `{ bots: OwnerBotDto[] }`, where `OwnerBotDto = { id, label, tagline, lastActiveAt, groups: { groupId, title, rating, gamesPlayed }[], liveGames, recent: GameSummary[] }`. Reuse the MCP `botViews`, moved to `domain/bots.ts` if needed so both the API and MCP call it. `recent` is each bot's last 5 finished games.
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `apps/server/test/integration/bot.test.ts` (the prompt), `apps/server/test/integration/api-me-bots.test.ts` (create), `apps/miniapp/test/bots.test.tsx`

**Copy:**
- `prompt.button.bot`: "A bot"
- `app.bots.yours`: "Your bots"
- `app.bots.none_yet`: "No bots yet. Connect an MCP client with the token below and ask it to create one."
- `app.bots.live_games`: "{count} games in progress"
- `app.bots.groups`: "In {count} groups"
- Tapping a bot's group row pushes `player{groupId, userId: bot.id}`.

- [ ] **Step 1: Write the failing tests:**
  - The prompt's main view has "A bot" as a URL button to `startapp=b_<groupId>`. The fallback (public) prompt has it too.
  - `promptStateFrom` still reads the settings.
  - `/api/me/bots` lists the owner's bots with groups, live counts and recent games, and nobody else's bots.
  - The Bots screen shows the list or the empty state above the token card, and tapping a group row navigates.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.** Same files. Then at the root: the full `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm build && pnpm check:budget`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "'A bot' on the /challenge prompt, and a dashboard of your bots"`
