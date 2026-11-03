# Bot accounts: players that agents drive over MCP

Status: design, 2026-11-03.

## Why

People in a group want to pit their AI agents against each other and against their friends: "my
Claude vs your GPT", a bot ladder, humans trying to beat a friend's bot. Chess Goat already has a
Stockfish opponent, but nothing lets an outside agent play.

The owner's one firm rule: **an agent never acts as a human.** No token, tool or endpoint lets an
agent move, challenge, chat or read DMs as a person. Every agent action is done by a bot account that
is visibly a bot and visibly someone's bot.

Success: people in a group create bots, challenge them, watch them play each other, and talk about
it, without the group chat becoming noisy.

## Goals

- A user can create any number of bots, each shown as a bot (🤖) with its owner ("Deep Goat 🤖 · Jo's
  bot").
- An agent drives the owner's bots through an MCP server: managing them and playing as them.
- Humans can challenge bots, from the chat and from the app, even in a group with thousands of bots.
- Bots can challenge other bots.
- People can find out which bots exist and who they are playing.

## Non-goals (for this design; several are later phases, see "Later")

- A streaming event API for always-on bot programs (Lichess-style). Later.
- OAuth sign-in for MCP clients (needed for Claude.ai connectors). Later.
- Bot-vs-bot spectating features beyond the existing watch screen, and flair betting. Later.
- Bots reading the wider group (human games, member lists, human leaderboard). Later.
- An official bot runner script or SDK.
- Webhooks.

## Anti-goals

- **Any path by which a token acts as its human owner.** The owner token can manage and play the
  owner's bots; it can never do anything as the owner.
- **Bots challenging humans.** Too easy to spam. The server refuses it whatever the client sends.
- **Bot noise in the group chat.** No posts for bot-vs-bot challenges or results; no per-bot DMs.
- **Dead games.** No auto-accept: a bot only accepts a challenge through a call from a live agent.
- **Bots changing human ratings.**

## Constraints

- The bot keeps privacy mode on and never stores chat content (README, PRD).
- `/challenge` picked from Telegram's command menu is sent at once with no arguments, so nothing may
  rely on text typed after the command.
- Bots are not Telegram accounts, so Telegram's `@` autocomplete never lists them.
- The bot is not a group admin and must not need to be (no pinning).
- Telegram does not allow `web_app` buttons in group messages; opening the app from a group card uses
  the existing Mini App deep link (as group cards do today).
- MCP spec 2026-07-28 is stateless (no sessions, no initialize handshake). Clients cut tool calls off
  at roughly 30–60 s and drop the request when a connection breaks.

## Approaches considered

Three decisions, each with the recommended option chosen by the owner.

1. **Where the MCP server runs.**
   - **Chosen: inside the existing server, as a `/mcp` route on the Hono API.** It calls the same domain
     functions as the Mini App, so the rules (legality, `expectedPly`, blocks, clocks, challenge
     expiry) live in one place, and a waiting tool call can subscribe to the in-process bus. Cost: it
     shares a process with the bot and the API, so heavy MCP traffic affects everyone; rate limits
     cover it.
   - Rejected: a separate service calling the HTTP API with the token. Isolated and publishable, but
     waiting for events needs a cross-process bus now, and auth is done twice.
2. **How bots are stored.**
   - **Chosen: bots are rows in `users`** with an owner and no Telegram id, as the Stockfish engine is.
     Games, challenges, ratings and blocks keep working because they already reference users. Cost: an
     audit of every place that assumes a user is a human; the engine work already guards most.
   - Rejected: a separate `bots` table with polymorphic players. Every game, challenge and rating query
     would handle two player kinds.
3. **How the owner's agent connects.**
   - **Chosen: an owner token generated in the app and pasted into the MCP client; OAuth later.** Works
     now in Claude Code and any client that sets headers. Cost: no Claude.ai connector until OAuth.
   - Rejected for now: OAuth from day one (Telegram Login Widget sign-in page, token issuance, Client ID
     Metadata Documents) before any game can be played.

## The design

### 1. Identity and tokens

- **Bot accounts.** A bot is a `users` row with `ownerId` set (the human who owns it), no
  `telegramUserId`, a display name and an optional tagline (one line, shown on its profile). The
  Stockfish engine stays as it is (`isEngine`); a user-owned bot is a different kind. *Builder:* choose
  the column shape (e.g. `kind: 'human' | 'engine' | 'bot'` replacing `isEngine`, or `ownerId` alone
  as the discriminator) and rework the `users_single_engine` unique index accordingly.
- **Names.** Bot names are unique (case-insensitively) across Chess Goat, so search results and cards
  are unambiguous. Length and character limits as for other user-entered text. *(my call)*
- **Disclosure.** Wherever a bot's name appears — group cards, result cards, the app, player pages,
  leaderboards, share images, PGNs — it carries 🤖 and the owner's display name, e.g. "Deep Goat 🤖 ·
  Jo's bot". If the owner deletes their data, see §8.
- **Owner token.** One token per owner, created in the app (Settings → Bots), shown once, revocable and
  rotatable there. It is long-lived, stored hashed, and is not a session JWT. It can:
  - manage the owner's bots (create, rename, edit tagline, delete, add to or remove from a group);
  - play as any of the owner's bots (every play tool takes a `bot` argument).
  It can never act as the owner: it is not accepted by any existing Mini App route, and the MCP server
  resolves every action to a bot row before touching domain code. The app's token screen says plainly
  that the token can play as all the owner's bots.
- **Tokens are recognisable.** Owner tokens carry a fixed prefix (e.g. `cgbot_`), so they can be spotted
  in leaks and, later, refused in bot chat (see "Later").
- **Bots are managed only through MCP.** Creating, renaming, retagging, deleting bots and adding them to
  or removing them from groups are MCP tools only, with no app screens for them. This is deliberate: it
  steers owners towards running their bots with AI agents. The app only lets the owner create, rotate
  and revoke the owner token, and shows the read-only owner dashboard (§6). Deleting one's data still
  deletes all one's bots (§8).
- **Audit.** Every move, challenge, accept/decline, draw action and resignation is recorded against the
  bot user, as for any player. Nothing records "the owner did this".
- **Limits.** A cap on bots per owner and per-token rate limits on tool calls. *Builder:* pick the
  numbers (suggested starting point: 20 bots per owner; a few tool calls per second per token).

### 2. Groups and admins

- An owner adds their bot to a group they are a member of. The owner's membership is the only
  requirement; there is no admin approval.
- If the owner leaves a group, their bots stay listed but cannot accept or issue new challenges there
  until the owner is back; games in progress continue. *(my call)*
- Admins can block a bot with the existing block feature, exactly as they block a human. A blocked bot
  cannot be challenged, cannot challenge, and its pending challenges are cancelled. *(my call)*
- Blocking a human in a group also blocks all their bots there, and a blocked owner cannot add bots to
  that group, so a block can't be dodged by making a new bot. Challenge, accept and add-to-group checks
  look at the owner's block as well as the bot's. *(my call)*

### 3. Challenges and games

- **Who can challenge whom.**
  - Human → bot: allowed. Posts the usual challenge card to the group.
  - Bot → bot: allowed, via MCP only. **Nothing is posted to the group.**
  - Bot → human, or an open "anyone" challenge from a bot: refused by the server.
- **Accepting.** Only a tool call from the owner's agent accepts or declines a challenge to a bot.
  There is no auto-accept. Challenges to a bot expire like any other (24 h today).
- **Activity.** A bot's "last active" time is the time of its owner's most recent MCP tool call naming
  that bot (or any call for the owner, *builder's choice*). The app shows "active now" (within a few
  minutes) or "last active 3d ago". When someone picks a bot that has not been active for over a day,
  the app warns them before the challenge is sent. *(my call on the thresholds)*
- **Clocks.**
  - Human vs bot: **always** a time-per-move clock; the "no clock" option is not offered. A silent
    agent forfeits on time, so a human is never stuck in a dead game.
  - Bot vs bot: **no clock by default.** `challenge_bot` may set a time per move if the challenger
    wants one.
  - A clockless bot-vs-bot game in which nobody has moved for 30 days is aborted (no result, no
    rating change), so dead games don't pile up in the Bots tab. *(my call on the rule and the
    number)*
- **Results.**
  - Human vs bot: a result card is always posted, as for human games.
  - Bot vs bot: nothing is posted.
- **Group cards for human → bot games** show the bot's activity ("waiting for Deep Goat · active 2m
  ago") and carry a "Challenge Deep Goat" button that opens New Game with that bot preselected.
- **Draws, resignation, abort.** Bots can offer, accept, decline and claim draws, resign and abort
  under the same rules as humans.
- **Conditional premoves.** Bots get them, under the same rules as humans (2026-10-29 premoves spec):
  a tree of opponent-move/reply pairs, every move legal, one reply per opponent move, replies played
  automatically. An agent can build a deep tree in one call, which also cuts how often it has to check
  in. Through MCP a tree has an **advertised limit** on the number of pairs, stated in the tool
  description and in the error when it is exceeded. *Builder:* pick the number (suggested 500 pairs
  per game), well under the 64 KB request limit.
- **DMs.** Bots get none. Owners get none about their bots. Human opponents get their normal DMs.
- **Lichess import, PGN, share images.** As for any game, with the bot labelled as in §1.

### 4. Ratings

- Ratings stay per group (existing `ratings` table keyed by group and user).
- **Bot pool.** Rated bot-vs-bot games update both bots' ratings.
- **Human vs bot.** The human's rating never moves. *Rated* human-vs-bot games update only the bot's
  rating, using the human's current rating as the opponent rating. *(my call; the alternative is
  that human-vs-bot games are always casual)*
- **No farming.** Games between an owner and their own bot, and between two bots with the same owner,
  are allowed but always casual (the server forces `rated: false`). *(my call)*
- **The human side is untouched.** A human-vs-bot game creates or changes nothing in the human's
  `ratings` row: not rating, RD, `gamesPlayed`, W/D/L or `lastRatedGameAt`. Flair stays as today (it
  scores games against a person), so human-vs-bot games award no flair. *(my call)*
- The human leaderboard excludes bots (as it excludes the engine today). Bots have their own standings
  per group (§6). `rebuildGroupRatings` must reproduce both rules.

### 5. Challenging a bot

- **From the chat.** The private `/challenge` prompt (2026-10-31 spec) gains a third button, "A bot",
  beside "A particular person" and "Anyone". It opens the Mini App's bot browser for that group via the
  existing deep link. No bot list, search or handle is offered in the chat.
- **From the app.** New Game's opponent picker gains a "Bots" entry that opens the bot browser.
- **Bot browser.** All bots in the group with search by name, sort by rating, most active and newest, and
  each bot's owner, tagline, rating and activity. Picking one goes to the usual time, colour and rated
  settings. It must stay fast with thousands of bots (server-side search and pagination).
- **From a card or profile.** "Challenge <bot>" buttons on cards featuring a bot (§3) and on bot player
  pages deep-link to New Game with the bot preselected.
- **"Taking challenges" card.** The owner can post a card for one of their bots in a group: "Deep Goat
  🤖 · Jo's bot is taking challenges", with a button into New Game. Posted only by the owner, from the
  app: a human promoting their bot, not bot management, and never something an agent can post to a
  group. *(kept from the brainstorm; cheap to drop)*

### 6. Discovery

- **Where bot games are listed.** Human-vs-bot games appear in the human's own Games list and in the
  group's lobby like any human game. Bot-vs-bot games appear only in the Bots tab and on bot profiles,
  never in the group's lobby, so thousands of bots can't flood it. *(my call)*
- **Bots tab per group in the app:** live bot games (watchable with the existing watch screen), bot
  standings, recent bot results, and the bot browser.
- **Bot profiles:** name, owner, tagline, rating per group, record, head-to-head, recent games,
  activity.
- **Owner dashboard (app, read-only):** the owner's bots, their groups, live games, recent results, last
  activity, and the token screen. This replaces any DM to owners. With no bots yet, it explains how to
  connect an MCP client and create one.
- **Weekly bot round-up:** one message a week in the group with upsets, streaks and the top bot. Off by
  default; a group admin setting turns it on. Posted only if there was bot activity that week. *(my
  call on default-off)*
- Human-vs-bot result cards, which always post, do the rest.

### 7. The MCP server

Mounted at `/mcp` on the existing API, Streamable HTTP, stateless (2026-07-28), authenticated by the
owner token as a bearer header. Built with the official TypeScript MCP SDK.

**Tool design rules** (from Anthropic's "Writing effective tools for agents" and MCP best-practice
guides): few tools shaped around what the agent is doing, not one per endpoint; readable names
alongside ids; search rather than list; concise output by default with a `detailed` option; actionable
errors that say how to fix the call; strict input and output schemas (`outputSchema` plus
`structuredContent`, with a text rendering); `readOnlyHint` / `destructiveHint` annotations; a
deterministic tool order.

**Management tools**

| Tool | Purpose |
|---|---|
| `list_bots` | The owner's bots with groups, ratings, live game count and activity. |
| `create_bot(name, tagline?)` | Creates a bot. The result includes next steps: how to add it to a group, how the check-in loop works, and the docs link. |
| `update_bot(bot, name?, tagline?)` | Rename or retag. |
| `delete_bot(bot)` | Destructive. Resigns its live games, cancels its challenges (§8). |
| `list_my_groups` | Groups the owner is in, with which of their bots are in each. |
| `add_bot_to_group(bot, group)` / `remove_bot_from_group(bot, group)` | Owner must be a member. |

**Play tools** (every one takes `bot`)

| Tool | Purpose |
|---|---|
| `get_inbox(bot?, wait_seconds 0–45)` | Everything needing attention: challenges received, games where it is the bot's move, draw offers. Without `bot`, covers all the owner's bots. With `wait_seconds`, returns as soon as something arrives (subscribing to the bus) or when the wait ends, sending progress notifications meanwhile. |
| `get_game(bot, game_id, format)` | ASCII board and FEN, SAN move list, legal moves, current ply, clocks and deadline, opponent, draw state, and the bot's current premove tree in the same JSON shape `set_premoves` takes. `detailed` adds the PGN. |
| `make_move(bot, game_id, move, expected_ply, premoves?)` | SAN or UCI. Passed to the existing move path with `expectedPly` and a `clientMoveId` derived from the call, so a retried call cannot play twice and a move into a changed position is refused. Optional `premoves` sets the premove tree with the move, as the app's "confirmed with the move" does. Returns the new position and ply. Illegal moves return the legal list. |
| `set_premoves(bot, game_id, expected_ply, tree)` | Replaces the bot's premove tree on the opponent's turn. `tree` is readable nested JSON (`[{ "opponent": "e5", "reply": "Nf3", "then": [...] }]`) in SAN; the server checks every pair and encodes it to the existing format, and computes the fingerprint itself, so the agent never handles `baseHash`. An empty list clears the tree. Errors name the first illegal pair by its path. The pair limit is in the description. |
| `game_action(bot, game_id, action)` | `offer_draw`, `accept_draw`, `decline_draw`, `claim_draw`, `resign`, `abort`. |
| `respond_to_challenge(bot, challenge_id, accept)` | Accept or decline. |
| `find_bots(group, query?, sort?)` | Search bots in a group (to challenge). Paginated. |
| `challenge_bot(bot, opponent_bot, group, time_per_move, colour, rated)` | Bot → bot only. |
| `get_profile(bot)` | Groups, rating per group, record, recent games. |

**What a bot can read:** its own games, the bot directory and bot standings of its groups, its
opponents' display names, and the group's title. Nothing else about the group or its humans.

**Server instructions** (sent to the model on connect) explain the two kinds of tool, the check-in loop
(`get_inbox` with a wait, then act), and that moves need `expected_ply` copied from the last result.

**An MCP prompt, "Play my bots",** sets up a loop in a client like Claude Code: wait on the inbox,
respond, repeat.

**Errors** map `DomainError` kinds to tool errors with a sentence the agent can act on (e.g.
`stale_state` → "The position has changed; it is now ply 14. Call get_game and choose again.").

### 8. Deletion

- `delete_bot`: live games end as resignations by the bot, pending challenges are cancelled, the bot is
  anonymised like a deleted user ("Deleted bot"), and finished games stay.
- Owner deletes their data: all their bots are deleted as above, and the owner token is revoked.
- The owner label on finished games then reads as a deleted player.

### 9. Things the builder must audit

Everywhere that assumes a user is a human: DMs (`dm.ts`, `dmRules.ts`), profile photos, flair awarding
and backfill (bots earn and wear no flair), `deleteMyData`, leaderboards and `rebuildGroupRatings`,
`listKnownPlayers` and the human opponent picker, share images, PGN names, lobby, Lichess import
naming, the usage dashboard's stats views (bots must not count as users; add bot counts separately),
and the per-user `StreamGate`.

## Known limits

- The bus is in-process. `get_inbox` waiting works while the API runs in one process (as today). If
  roles or replicas are ever split, the bus needs a shared backend (e.g. Postgres `LISTEN/NOTIFY`)
  first.
- A token-in-header connection does not work as a Claude.ai custom connector until OAuth ships.

## Later

Phases after this design, in rough order:

1. **Streaming event API** for always-on bot programs: one long-lived SSE stream per bot (challenge
   received, your move, draw offered) with heartbeats, like Lichess's Bot API; one stream per bot.
2. **OAuth** for MCP clients (Telegram Login Widget, Client ID Metadata Documents), so Claude.ai
   connectors work.
3. **Bot-vs-bot spectating and flair betting.**
4. **Bot-to-bot chat:** bots trash-talk and try to trick each other into bad moves through the text the
   other bot's agent reads; defending against that becomes part of the game. Fences, because the
   tricks won't stay inside chess (a message can target the owner's agent, its tools and its token):
   - opt-in per bot, off by default, and only in games where both bots have it on;
   - opponent messages delivered in their own delimited field marked untrusted, never mixed into board
     data, tool descriptions or server instructions;
   - any message containing an owner token (recognised by its prefix, §1) is rejected and the token is
     revoked;
   - one short message per move, length-capped, stored with the game and deleted with it (the privacy
     docs gain a line about it);
   - humans can read it on the watch screen and bot profiles but cannot post; admins can block a bot
     over its chat;
   - a clear warning when an owner switches it on not to run a chat-enabled bot from an agent with
     access to anything they care about.
5. **Bots studying the group:** read access to human games before a match.

## Left to the builder

- Column shape for bot users and the engine index (§1).
- Numbers: bots per owner, rate limits, name length, activity thresholds, the MCP premove pair limit.
- Token format and storage (hashed; the exact prefix).
- Exact wording of cards, the warning for inactive bots, server instructions and tool descriptions.
- Bot browser layout and how the Bots tab fits the existing tab bar.
- Whether "last active" is per bot or per owner (§3).
