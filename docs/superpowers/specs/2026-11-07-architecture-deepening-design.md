# Architecture deepening after Bots 1–4

Status: design, 2026-11-07.

## Why

The Bots work (#121, #122, #127, #128) added bot rules one call site at a time. The rules work, but
each one now lives in several places, and the copies have started to disagree. This design gathers
six of them into deep modules: a small interface with the rule behind it, tested through that
interface. Terms in **bold** are defined in `GLOSSARY.md`.

Every step is a **refactor**: behaviour stays exactly as it is, except for the one bug fix in step 2
(MCP hints that blame the wrong player). Each step is one PR.

## Order

1. **Pairing** module
2. Domain errors that name their subject; one MCP hint table
3. **Player Kind**
4. **Game Mix** and **Game Audience**
5. The bot's move goes through `playMove` (independent; may run in parallel with 2–4)
6. **Bot View**: schemas and queries out of the MCP tools

Step 2 depends on step 1 (Pairing is where most of the subject-carrying errors are thrown), and
step 4 depends on step 3 (who gets DMs is a Player Kind question). Step 6 goes last because step 5
already moves part of it.

## Testing rules (all steps)

- **Replace, don't layer.** When a module gets its own test suite, delete the older integration
  tests that reached the same behaviour indirectly. Keep one or two end-to-end smoke tests per area
  to prove the wiring.
- **Guard tests.** A vitest source scan fails the build if `botPlayers` is read outside the Game Mix
  module (the schema's index and check constraints are exempt), or if `isEngine` / `isOwnedBot` /
  `isHuman` is used outside the Player Kind module. Each guard lands in the step that creates its
  module.

## 1. Pairing

**Today.** `createChallenge` and `acceptChallenge` (`apps/server/src/domain/challenges.ts:186-212`,
`:313-332`) each call `assertNotBlocked`, `assertBotsMayPlay`, `assertBotsNotBusy`,
`countBotPlayers` and `assertBotClock` by hand, plus their own inline bot rule. The same "may play"
rule exists again as SQL (`findableIn`, `botGroups.ts:103`), which also checks `deletedAt` while the
procedural copy does not. "Is an active member" is spelled three ways
(`mcp/tools/challenge.ts:48`, `mcp/tools/manage.ts:162`, `botGroups.ts:29`).

**Design.** A new module, `apps/server/src/domain/pairing.ts`:

- `mayPlay(tx, group, player)` checks one player: a live account, an active member, not blocked,
  and for a Bot, an Owner who is an active member too.
- `checkPairing(tx, group, a, b | null, terms) → { botPlayers, rated }` uses `mayPlay` for both
  players, then applies the pair rules: no self-challenge, bots challenge only bots, bots never take
  open challenges, the live-game cap, the bot clock rule, and same Owner means casual. Otherwise it
  throws one `DomainError`.
- `findableIn(groupId)` (the SQL form, for listing bots) moves here, next to the per-pair check.
- The pending-challenge limit stays in `createChallenge`, because it limits the challenger rather
  than the pair.

The per-pair check is the source of truth. **One table of cases runs against both** `mayPlay` and
`findableIn`, so the two forms cannot drift apart.

`isActiveMember(tx, group, user)` in `members.ts` replaces the MCP `find_bots` owner check.
`addBotToGroup` keeps its two separate checks (owner is a member; bot or owner not blocked) because
they answer with different reasons. `list_my_groups` moves to the domain in step 6.

**Callers.**

- `createChallenge` and `acceptChallenge` call `checkPairing`.
- `announceBot` calls `mayPlay`. The announce job (`jobs/handlers/telegram.ts:183`) and the
  lobby's `findable` flag keep `isFindableBot`, the SQL form, since they want a yes/no answer.
- MCP `challenge_bot` drops its `isFindableBot` pre-check. Today that pre-check deliberately gives
  the same `opponent_not_found` answer for a human, an unknown id and an unfindable Bot, so that an
  agent cannot probe who exists. After step 2, the MCP translator does that hiding instead: a
  Pairing error *about the opponent* with a reason in the "can't be found" set becomes
  `opponent_not_found`. That set is: is a human, deleted, not in the group, owner not a member,
  blocked. Until step 2 lands, step 1 keeps the pre-check, so the hiding never lapses.

**Tests.** A table-driven integration suite against `checkPairing` / `mayPlay` (real Postgres)
replaces the Pairing cases in `bot-challenges.test.ts` and `bot-games.test.ts`. The busy-bot case
seeds 50 games directly instead of creating them through the challenge flow.

## 2. Errors that name their subject

**Today.** `apps/server/src/mcp/errors.ts` chooses a hint by `reason` alone. When the *opponent*
has 50 live games, the agent is told its own bot has. `owner_not_member` raised while accepting a
challenge blames the caller. Limits are hard-coded (20 / 50 / 3), and a message can be added in
three different places: the `HINTS` table, special cases in code, or the fallback text.

**Design.**

- `DomainError.details` carries `subjectId`, the user the error is about, and the relevant values
  (`limit`, `name`, …), read from `limits.ts`.
- `mcp/errors.ts` becomes one table keyed by reason. Each entry is `(details, viewer) => string`,
  and the viewer is the calling Bot and its Owner. Comparing `subjectId` with the viewer chooses
  between "your bot", "your opponent Knightbot" and "the challenger's owner".
- The table also applies the opponent-hiding rule from step 1.
- A test fails if any domain reason has no table entry.
- Telegram's replies to people (`bot/replies.ts`) are out of scope.

**Tests.** Every table entry is unit-tested through `toolError`. Hint assertions made over HTTP
(for example, `mcp-play.test.ts:348-366`, which seeds 50 games to check one string) are replaced.

## 3. Player Kind

**Today.** `PlayerRef.isBot` means the Engine (`players.ts:29`, `sharePhoto.ts:78`), while MCP
`opponent.isBot` means a Bot (`mcp/render.ts:69`, `botInbox.ts:63`). About 69 ad-hoc checks of
`isEngine` / `isOwnedBot` / `isHuman` decide flair, DMs, photos and ratings separately.

**Design.**

- `kindOf(user): 'human' | 'engine' | 'bot'` plus capability queries (`wearsFlair`, `getsDms`,
  `hasAvatar`, `isRated`), backed by one table of what each kind can do. The table reproduces
  **today's behaviour exactly**, including where the current rules disagree (for example, profile
  photos exclude only the Engine, while flair excludes both the Engine and Bots). Each such case is
  written down as a row with a comment. Changing any of them is a follow-up, not part of this step.
- In `packages/shared`, `PlayerRef.isBot` is replaced by `kind`, and MCP `opponent.isBot` maps to
  the same values. The Mini App (`Avatar.tsx`, `GameCard.tsx`, `PlayerBar.tsx`) is updated in the
  same PR. The server and Mini App ship together, so no compatibility shim is needed.
- The `isEngine` / `isOwnedBot` / `isHuman` guard test lands here.

## 4. Game Mix and Game Audience

**Today.** About 15 call sites do arithmetic on `botPlayers` (`=== 2` silent, `=== 0`
importable, `=== 1` frozen rating side, `> 0` roundup). DM suppression is checked twice: once in
`wantsDms`, and again by each caller through `isOwnedBot`.

**Design.** One module (`apps/server/src/domain/gameMix.ts`):

- `mixOf(game): 'humans' | 'mixed' | 'bots'`, still derived from the stored `botPlayers`. No
  migration.
- `audienceOf(game, players) → { chat, importable, dmRecipients, roundup }` and the rating-pool
  decision, both derived from the mix (and from Player Kind for DMs).
- SQL fragments for the lobby and the clock scanner filters.
- Callers ask the module instead of counting. The `botPlayers` guard test lands here.

**Tests.** A pure table test of mix → audience replaces audience checks that inspect the job queue
in the bot-games, bot-roundup and scanner suites, except for one smoke test each.

## 5. The bot's move goes through `playMove`

**Today.** MCP `make_move` (`mcp/tools/play.ts:56-106`) resolves SAN or UCI with chess.js and
checks staleness, game over, retries, the side to move and legality in its own transaction. Then
`playMove` (`domain/games.ts:519`) repeats those checks under the lock, and a fourth transaction
reloads the view. `playMove` takes `premoveTree`, `premoveNodes` and `premoveCheck: 'shape'`
because humans and bots treat illegal premoves differently: a human's is rejected, a bot's is
recorded (migration 0017).

**Design.** `playMove` is widened rather than adding a bot-only entry point:

- `move: string` (UCI or SAN), resolved **under the lock** against the position at `expectedPly`.
  An illegal move throws `illegal_move` with the legal list in its details.
- Retry check: "this user already played this UCI at this ply" holds for every caller. It replaces
  MCP's custom `clientMoveId` string; the Mini App's own `clientMoveId` is still honoured where it
  is sent.
- `premoves: { tree, ifIllegal: 'reject' | 'record' }` replaces the trio. The Mini App passes
  `'reject'` and MCP passes `'record'`. The human legality check stays outside the lock, as today.
- It returns the committed game and move. Each caller renders its own view: HTTP builds the
  `GameDto`, MCP builds the Bot View, and the engine job ignores it.
- `game_action` loses its separate authorizing transaction in the same way.

MCP `make_move` becomes: validate the input, `resolveAndTouch`, `playMove`, then render.

**Tests.** Legality, staleness and retries are tested against `playMove` with plain `db` calls,
replacing their JSON-RPC versions in `mcp-play.test.ts`. One MCP smoke test remains.

## 6. Bot View

**Today.**

- `GameView` (`mcp/render.ts:7`) is copied by hand as `gameViewSchema` (`mcp/tools/read.ts:20`).
- `InboxEntry` (`domain/botInbox.ts:12`) is copied by hand as `entrySchema`
  (`mcp/tools/inbox.ts:20`).
- The draw-offer state is worked out twice.
- `list_my_groups` is about 45 lines of SQL inside `mcp/tools/manage.ts:155`.

**Design.**

- The zod schemas for the Bot View of a game and of an inbox entry live in the domain and are the
  source of truth. The types are inferred with `z.infer`, and the MCP tools import the schemas.
- The draw-offer state is computed once.
- `list_my_groups` moves into the domain as `ownerGroups`.

**Deferred, and checked (2026-11-08): the two membership checks do differ.**

- The HTTP bot browser uses `requireMember` → `membership.verify`. It asks Telegram
  (`getChatMember`, with a cached verdict) and ignores `blockedAt`.
- MCP `find_bots` uses `isActiveMember`, which reads only the database row and refuses blocked
  users.

So a blocked person can browse a group's bots in the Mini App, but their agent cannot. Someone who
has left the Telegram group is refused by the Mini App as soon as Telegram says so, but their agent
is refused only once the row is updated. Which rule is right is a product decision, so the two are
not unified here.

## Out of scope

- Any change in behaviour beyond the step 2 hint fix.
- Telegram's replies to people.
- Odd cases in the Player Kind table: written down, not changed.
