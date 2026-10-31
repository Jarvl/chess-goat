# Chess Goat — Product Requirements Document

| | |
|---|---|
| **Product** | Chess Goat — a Telegram bot for playing and watching 1v1 chess with the people in a group chat |
| **Status** | Draft v0.2, for review |
| **Date** | 2026-09-20 |
| **Next step** | Technical requirements and architecture document: [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](superpowers/specs/2026-09-20-group-chess-technical-design.md) |

---

## 1. Summary

Chess Goat lets the members of a Telegram group play chess against each other and watch each other's games. Games are played on a fully interactive board (hold-and-drag pieces, like Lichess or Chess.com) inside a Telegram Mini App. The group chat itself stays quiet: one card per game, results when a game ends, and board positions that a player or spectator deliberately shares so the group can talk about them.

The bot is not a chess server and does not try to replace Chess.com or Lichess. It is the simplest way for a group of friends to play each other, keep a record, and argue about the games. Analysis is handed off to Lichess after a game is over.

## 2. Problem and opportunity

- The people you want to play are already in the group chat. Existing chess bots are private-chat or inline-message toys with no shared history and no spectators.
- Playing on a chess site means leaving the chat, creating accounts and sharing links. The social part (spectating, commenting on a position, a leaderboard the group cares about) is lost.
- Telegram Mini Apps make a real, draggable board possible from inside the chat, with a link that opens the board on top of the group and returns you to the group when you're done.

## 3. Goals and non-goals

### Goals

1. **A real board.** Hold-and-drag or tap-tap moves, legal-move hints, the same feel as a web chess app.
2. **One tap from chat to move.** A player opens their game from the group or from a notification, moves, and is back in the chat.
3. **Spectating by default.** Every game in the group can be watched live and replayed later, from the app.
4. **A quiet group chat.** No board per move, no command chatter. Only game cards, results, and positions people choose to share.
5. **Simple and permanent.** Standard chess, no takebacks.

### Non-goals and decisions already made

These were considered and are explicitly out of scope, so they should not creep back in:

- Puzzles, vote chess, tournaments, seasons, variants.
- Takebacks. All moves are permanent.
- Spectator predictions, watcher counts, blindfold mode.
- Any analysis (engine evaluation, hints, accuracy) before a game is over, for players or spectators. After a game ends, analysis is a link to Lichess, not a feature in the app.
- Copy-FEN buttons in the chat.
- A keyboard-based move picker in the chat, and board images posted on every move.
- Real-time blitz and bullet. Clocks are per-move (hours or days). Faster clocks can be revisited once the Mini App is proven.

An engine opponent was originally on this list and was deliberately added to the product on
2026-09-21; see
[docs/superpowers/specs/2026-09-21-engine-opponent-design.md](superpowers/specs/2026-09-21-engine-opponent-design.md).
The remaining items above are still out of scope, in particular any in-app analysis (§7.8).

Flair, emoji earned in play and worn beside a name, was deliberately added on 2026-09-29; see
[docs/superpowers/specs/2026-09-29-flair-design.md](superpowers/specs/2026-09-29-flair-design.md).

## 4. Users

| Persona | What they want | Key moments |
|---|---|---|
| **The player** | Start a game with a specific person quickly, move on a proper board, know when it's their move, never lose on time by accident | Challenge, open game, move, return to chat, game end |
| **The spectator** | See what games are going on, watch one live, replay a finished one, share a position to the chat to comment on it | Game card, watch, replay, share position |
| **The group admin** | Add the bot and forget about it; a few defaults; the ability to void a game | Onboarding, settings |

Group sizes range from three friends to a club of a few hundred. The chat footprint must be tiny for both.

## 5. Feasibility of the two key requirements

### 5.1 Drag-and-drop pieces

**Possible, in the Mini App only.** Telegram chat messages cannot host interactive content; the only interactive element in a message is a button. A Mini App is a web view inside Telegram, so a standard web chess board with pointer and touch drag works there, on phones and on desktop.

Two things make it reliable on phones, both available in the Mini App API:

- Disable vertical swipes while the board is on screen, so dragging a piece up the board doesn't collapse or close the app sheet.
- Expand the app to full height on launch (fullscreen is also available), so the board is large and nothing else scrolls.

Existing open-source board libraries already implement hold-and-drag, tap-tap, legal-move dots, drop snapping and promotion dialogs. Choosing one is a technical decision (see open questions: licence).

### 5.2 Open from the group, move, return to the group

**Possible.** A URL button on a message in the group can carry a direct link to the Mini App (`t.me/<bot>/<app>?startapp=<game>`). Direct links work inside group chats (inline "web app" buttons do not; they are private-chat only). Tapping the button opens the Mini App as an overlay on top of the group chat. When the app closes itself after the move, or the user taps back or close, they are back in the group chat where they tapped.

The same link from a "your move" DM returns the user to the DM instead; that message can carry a second button that jumps to the group.

## 6. Core user journeys

### 6.1 Add the bot to a group

1. An admin adds the bot to the group.
2. The bot posts one welcome card: a one-line description and an **♟ Open Chess** button (the Mini App lobby for this group). Admins may pin it as the group's permanent entry point.

Acceptance: no configuration needed before the first game.

### 6.2 Challenge someone

Two paths, both one step:

- **In the chat**: send `/challenge @bob`, or reply to any message from Bob with `/challenge`. The bot posts a game card: "Alice vs Bob · 1 day per move · [Accept] [Decline]". Only Bob can accept.
- **In the app**: Alice opens the lobby, taps **New game**, picks Bob from the group's players (people the bot has seen in this group) or chooses **Open challenge**, sets the time control, and confirms. The bot posts the same card to the group.

Acceptance: the challenged player is mentioned on the card (so they are notified) and, if they have allowed DMs, gets a DM with an **Open** button.

### 6.3 Make a move

1. Bob receives "your move" (DM, or the badge in the lobby) or sees the game card in the group.
2. Bob taps **♟ Open game**. The Mini App opens over the chat, showing the board from his side with the last move highlighted.
3. Bob drags a piece (or taps piece then square). Legal targets are shown while he holds the piece. An illegal drop snaps back silently. If **Move confirmations** applies to this game (by default, any game against a person), **Confirm move** and **Cancel** appear in Telegram's bottom bar; otherwise the move is sent on drop.
4. The app shows "Sent" and closes, returning Bob to the chat (setting: stay in the app instead).

Acceptance: from tapping the card to being back in the chat, no more than three taps for a normal move.

### 6.4 Watch a game

1. Carol taps **♟ Open game** on the game card (or opens the lobby and picks the game from the group's active games).
2. She sees the live board, move list and clocks. Pieces are not draggable for her. Moves appear as they happen.
3. If a position is worth discussing, she taps **Share position**; the bot posts that position as an image to the group with the move number, and the group replies to it in the chat as usual.

### 6.5 Replay an old game

1. From the lobby's **Finished** tab for the group, Carol opens any past game.
2. She scrubs through the moves with a slider or arrows, and can share any position to the chat.
3. **Analyze on Lichess** opens the game on Lichess for engine analysis.

## 7. Functional requirements

Priorities: **P0** = launch, **P1** = fast follow. Almost everything is P0 because the product is intentionally small.

### 7.1 Onboarding — P0

- Welcome card on join with the **♟ Open Chess** button. Optional pin (needs pin rights).
- Bot profile has the Main Mini App button, so the lobby also opens from the bot's profile without any message in the group.
- Group-scoped command menu contains only `/challenge`, `/chess` and `/settings`.
- The first time a user opens the app, it asks for permission to send them DMs (used for "your move" and challenge notifications). The app works if they decline.

### 7.2 Challenges — P0

- Direct challenge with `/challenge @name` or by replying `/challenge` to the opponent's message in the group, or from the app by picking a player the bot has seen in that group.
- Open challenge from the app or `/challenge` on its own: the first person other than the challenger to accept gets the game.
- Options: time per move (`1h`, `8h`, `1d` default, `3d`, `7d`, none), colour (random default, or choose), rated or casual (rated default).
- The game card in the group is the challenge card edited in place on accept. Declined and expired (24 h) challenges are edited to say so, not deleted.
- **Rematch** from the game-end screen in the app or the game-end card creates a reversed-colour challenge already accepted by the presser.
- Limits: 3 pending challenges per user per group; at most 5 active games per user per group (admin-configurable); at most 2 concurrent games between the same pair.
- Because the Bot API has no member list and cannot resolve a `@username` the bot has never seen, the app's opponent picker lists only players who have interacted with the bot in that group. Reply-to-message challenges always work.

### 7.3 Gameplay and rules — P0

- Standard chess with full rules, validated on the server: legal move generation, castling, en passant, promotion, check, checkmate, stalemate, threefold and fivefold repetition, 50- and 75-move rules, insufficient material.
- Moves are permanent. No takebacks, no undo, no abort after the second move.
- **Draw offers**: offer from the app; the opponent sees Accept/Decline in the app on their turn; the offer lapses when they move. **Claim draw** appears in the app when a threefold or 50-move claim is available; fivefold, 75-move and insufficient material end the game automatically.
- **Resign** requires a confirmation. **Abort** (no rating change) is available before both players have moved.
- **Clocks**: time per move, reset on every move. On timeout the player to move loses; if they have not yet made any move in the game, the game is aborted instead. Clocks must survive server restarts.
- Illegal input never produces an error message. The piece snaps back; nothing else happens.

### 7.4 The board (Mini App) — P0

- **Moving**: hold-and-drag and tap-tap, both always available. On pick-up, the piece's legal destinations are marked. Drop on a legal square plays the move; drop anywhere else snaps back silently. Promotion opens a four-piece chooser over the target square.
- **Who can move**: only the player whose turn it is. The other player can queue **premoves** instead (below). For spectators the pieces are simply not draggable. No toast, no message.
- **Conditional premoves**: a player can prepare replies in advance, on the opponent's turn or on their own turn once they have played their move. Premoves form a tree: each branch is a pair, an opponent move they expect and their single reply to it, and under a reply hang the pairs for the opponent's next move. Every move in the tree is fully legal in the position its line reaches, so the board is live for both sides while building. There is no size limit beyond the request size (about 9,000 pairs). When the opponent plays a move the tree has a branch for, the server plays the reply at once, even with the app closed, and the rest of that branch becomes the new tree; an opponent move the tree has no branch for clears it, and the player is told in the turn DM and in the app. A line that simply runs out cancels nothing. Removing or replacing a premove always asks first. With move confirmations on, premoves are a draft confirmed with the move (**Confirm move + 2 premoves**) or on their own (**Confirm premoves**); with them off, each completed change saves at once. Premoves are visible only to their owner, on every device they have the game open on. Design: [conditional premoves spec](superpowers/specs/2026-10-29-conditional-premoves-design.md).
- **Move confirmations**: user setting, one of Always, Only against people (default) and Never. Moves are permanent and mobile drops are easy to fumble, which matters most against a person; a bot game is many quick moves where the extra tap costs more than a slip. When a move needs confirming it is shown on the board with **Confirm move** / **Cancel** before it is sent. Leaving the game cancels it, asking first when it holds unconfirmed changes.
- **Orientation**: the viewer's own colour at the bottom; spectators see White at the bottom with a flip control.
- **Board UI**: last move highlight, check highlight, coordinates, move list (SAN) with tap-to-view of earlier positions (view only; making a move from a past position first returns to the current one), both clocks with time remaining, player names and ratings, draw offer and resign controls.
- **Live updates**: opponent moves, draw offers and game end appear without refresh, for players and spectators.
- **Feel**: haptic feedback on drop, capture and check (where the device supports it); light and dark theme following Telegram's theme; board theme and piece set choice in settings (P1).
- **After a move**: default is to close the app and return to the chat. Setting to stay in the app.
- **Mini App hooks required**: expand on launch (fullscreen optional), disable vertical swipes while the board is shown, back button and main button integration, theme parameters, request write access for DMs, close.

### 7.5 What the group chat sees — P0

The bot posts nothing to the group except the following:

| Message | When | Content and buttons |
|---|---|---|
| Welcome card | Bot added | One line plus **♟ Open Chess** |
| Game card | Challenge created; edited on accept, and again at game end | Players (with colours once assigned), time per move, rated/casual; status line ("Move 12 · Bob to move") updated silently as the game goes; **Accept**/**Decline** while pending; **♟ Open game** while running; result, **Analyze on Lichess** and **Rematch** when finished |
| Shared position | A player or spectator taps Share position in the app | Portrait snapshot card of that position (the board between both players' bars with their ratings and captured material, the result once the game is over, and a Chess Goat footer naming the bot), caption "Alice shared move 23 of Alice vs Bob", **♟ Open live game** button. Group members reply in the chat as usual |
| Reply to `/challenge` | Only when the command cannot be fulfilled | One short line (for example, the opponent already has 2 games with you) |

Wherever these messages name a player, in the text or in a photo's caption, the player's worn flair
follows the name ("Alice 👑 vs Bob 🔥🤝"). The snapshot images themselves do not carry it yet.

Edits to the game card are silent (no notification). There are no per-move messages, no nudges in the group, no bump or re-post behaviour. Status-line edits are throttled to at most one per move.

### 7.6 Sharing positions — P0

- Available from the live board and from replays, for players and spectators alike.
- Posts a rendered board image (with last-move highlight) to the game's group. The image is static; it is a talking point, not a board.
- While the game is running the share carries no analysis link. Once the game is over, shares and the game card carry **Analyze on Lichess**.
- P1: share to any chat via Telegram's share sheet from the app (prepared inline message).

### 7.7 Notifications — P0

- **In-app**: the lobby shows "Your move" games first, with a badge.
- **DM**: for users who granted write access, a DM on each turn change ("Your move vs Alice 👑 · 12. Nf3 · 23 h left") with **♟ Open game** and **Go to group** buttons; one reminder at 10 % of the move time remaining for controls of 8 h or more; a DM when the opponent offers a draw while it is your move (an offer made with a move rides on the turn DM instead); a DM when challenged; and a result DM ("You won vs Alice · Resignation · 1512 (+8)") when a game ends by something other than your own action. Each game or challenge keeps **at most one live bot message**: a new DM replaces the previous one, which is deleted, or reduced to one line once Telegram no longer allows deleting it (after two days). After you move, your DM quietly becomes "✓ You played 12… Nf6 · waiting for Alice". Names carry worn flair. Design: [DM notifications spec](superpowers/specs/2026-09-29-dm-notifications-design.md).
- **Group**: none. The challenge card mentions the challenged player once; that is the only mention the bot ever makes.
- Open question: whether to offer an admin-controlled group mention as a fallback for users who declined DMs (default off).

### 7.8 Spectating and history — P0

- The lobby, opened from any game card or from the bot profile, is scoped to a group and has **Active** and **Finished** tabs. From the profile it first lists the user's groups.
- Active games open on the live board in view-only mode. Finished games open in the replay view (slider and arrows, move list, share position, Analyze on Lichess, download PGN).
- Search and filter finished games by player (P1).
- No engine evaluation, hints or annotations anywhere in the app, at any time.

### 7.9 Ratings and stats — P0

- Per-group Glicko-2 rating (start 1500, shown as provisional until settled) for rated standard games. Rating changes are shown on the game-end screen and card.
- Lobby **Players** tab: leaderboard for the group (rating, W/D/L; everyone with a rated game in the group, provisional players ranked alongside settled ones and marked `?`), and a player page with record, head-to-head versus the viewer, and recent games.
- No seasons, no resets except by an admin voiding games.

### 7.10 Lichess analysis — P0

- When a game ends, the server imports the PGN into Lichess via `POST /api/import` (unauthenticated or with an OAuth2 token; either way the response is immediate, not queued) and stores the resulting game URL. The game-end screen, the game card and later position shares link to it. On Lichess the user can request computer analysis with the normal Lichess controls, a website feature open to any visitor of the game page.
- Fallback if the import fails or is rate-limited (100 imports/hour unauthenticated, 200/hour with an OAuth2 token): link to the Lichess analysis board with the final position (client-side engine, no account needed) and offer the PGN download.
- Nothing links to Lichess until the game is over.

### 7.11 Settings and admin — P0

In the app, under the group, visible to group admins only (verified against Telegram's chat member API):

- Default time per move; rated by default; allow open challenges.
- Where game cards are posted in forum groups: the topic the challenge was made in, or a fixed topic.
- Void a game (rating reverted, marked void in history) and block a user from starting games in this group.

`/settings` in the group posts a single **Open settings** button for admins.

### 7.12 Privacy — P0

- Privacy mode stays on. The bot receives only its commands, replies to its own messages, button taps and Mini App requests. It never stores chat content.
- Stored per user: Telegram id, first name, username (display), profile photo (a small copy, refreshed at most daily), games, ratings, earned and worn flair, notification permission and app preferences. A **Delete my data** action in the app anonymises the user in past games and removes the photo, preferences and flair.
- Mini App requests are authenticated with Telegram's signed launch data; a user can only act as themselves.

### 7.13 Bot opponent — P1

- Any group member can play the bot, at one of four levels, inside that group.
- Bot games are unrated: they never enter Glicko-2, W/D/L or the leaderboard.
- Nothing about a bot game is posted to the group chat on its own — no card, no result, no reminder.
- The one exception is **Share position** (§7.6): a player may share a position from a bot game like
  any other, because that is a deliberate tap and goal 4 already allows "positions people choose to
  share". What goal 4 keeps out of the chat is what the system posts unasked.
- Bot games have no clock. The bot replies at once, so a per-move time limit measures nothing and
  could only cost someone a casual game they walked away from. The time control is not offered when
  the bot is the chosen opponent.
- The bot never notifies the player about moves: no "your turn" DM when it replies, and no reminder.
  The in-app game-end result stays, since it reports a result rather than a move; no DM is sent.
- No rating numbers are shown for the levels.

## 8. UX specification

### 8.1 Group messages

Game card while running:

```
♟ Alice (1520) vs Bob (1498)
1 day per move · Rated · Move 12 · Bob to move
[ ♟ Open game ]
```

Game card when finished:

```
♟ Alice (1520 → 1534) vs Bob (1498 → 1484)
Checkmate · 1-0 · 34 moves · 1 day per move
[ 🔁 Rematch ] [ 🔍 Analyze on Lichess ]
```

Shared position:

```
[ snapshot card ]
Carol shared move 23 of Alice vs Bob
[ ♟ Open live game ]
```

### 8.2 Mini App screens

- **Lobby (group)**: header with group name; tabs Active · Finished · Players; **New game** button. "Your move" games pinned to the top of Active.
- **Game**: board fills the width; above it the opponent's name, rating and clock; below it yours; a compact move list; a replay slider with arrow controls; for players, an icon bar with four fixed slots: Share to group, Flip, Draw (dimmed to Offered once you offer, and before the second move) and Resign (Abort before the second move); Draw, Abort and Resign each ask to confirm. Spectators of a live game get Share to group and Flip in two wide slots of the same bar.
- **Game end**: no result card; a Won, Lost, Draw, Aborted or Voided tag takes each clock's place, the reason (e.g. Checkmate) replaces the winner's second line (both lines for a draw), and each rating shows its change. The icon bar keeps its slots: **Share to group**, **Analyze** (Lichess), **PGN** and, for players, **Rematch**. Telegram's own Close replaces Done.
- **Replay**: board, slider and arrow controls, move list, Share position, Analyze on Lichess, PGN.
- **New game**: opponent (list of group players, or Open challenge), time per move, colour, rated toggle, **Send challenge**.
- **Settings**: flair (earned emoji worn beside your name, in three slots), move confirmations, return to chat after moving, notifications, board theme and piece set (P1). Group settings for admins.

### 8.3 Commands

The bot has three group commands and no others in the group menu:

| Command | Purpose |
|---|---|
| `/challenge @name`, or as a reply to someone | Challenge that person with the group's default settings |
| `/chess` | Post an **♟ Open Chess** button (for groups that did not pin the welcome card) |
| `/settings` | Post an **Open settings** button (admins) |

`/start` in a private chat opens the lobby and enables DMs. Everything else happens in the app.

### 8.4 Copy and tone

Short and chess-literate. Standard notation (SAN, "1-0", "½-½"). Emoji only as button icons and as flair beside names. No error messages for illegal or out-of-turn moves; the board just does not accept them.

## 9. Telegram platform feature map

Bot API version tags below were verified against core.telegram.org/bots/api-changelog and core.telegram.org/bots/webapps on 2026-09-20.

| Product feature | Platform capability | Notes and caveats |
|---|---|---|
| Interactive board | Mini App (web view) | The only way to get drag-and-drop inside Telegram. |
| Open the board from a group message | Direct-link Mini App via URL button (`t.me/<bot>/<app>?startapp=<game>`) | Inline `web_app` buttons are private-chat only. Direct links work in groups and open the app over the chat. Launch data includes the user and the start payload. |
| Return to the chat after moving | Mini App `close()` | Closing returns to wherever the app was opened from. |
| Reliable dragging on phones | `disableVerticalSwipes()` (Bot API 7.7, July 2024), `expand()` (base WebApp API, no later version tag), fullscreen mode (Bot API 8.0, November 2024) | Prevents the app sheet from collapsing during a drag. |
| Lobby without a group message | Main Mini App on the bot profile (Bot API 7.8, July 31, 2024) | Also reachable from the attachment menu once configured. |
| DM notifications | `requestWriteAccess()` in the Mini App (Bot API 6.9), then ordinary private messages | Bots cannot DM users who never allowed it. |
| Feel | Haptic feedback, theme parameters, back button, main button | Standard Mini App APIs. |
| Identity in the app | Signed launch data (`initData`) | Server-side validation; the source of truth for who is moving. |
| Game card and silent status edits | `editMessageText` / `editMessageReplyMarkup` | Bot messages can be edited indefinitely; edits don't notify. |
| Challenge notification without DMs | Text mention in the challenge card | One mention per challenge, nothing else. |
| Shared position image | `sendPhoto` to the group, with the game's topic id in forum groups | Static image, no keyboard except Open live game. |
| Share to any chat (P1) | `shareMessage()` with `savePreparedInlineMessage` (Bot API 8.0) | User picks the chat in Telegram's share sheet. |
| Forum groups | `message_thread_id` (Bot API 6.3) | Cards go in the challenge's topic or a fixed topic. |
| Admin check for settings | `getChatMember` | Verified on every settings request. |
| Command menu | `setMyCommands` with group scope | Keeps the group menu to three commands. |
| Lichess analysis | Lichess game import API and analysis-board URL | `POST /api/import` takes a PGN, needs no authentication, and returns a permanent game id and URL immediately (no queueing). Rate limit: 100 imports/hour unauthenticated, 200/hour with an OAuth2 token — worth an app token at the 5,000-group scale target. Requesting computer analysis is a lichess.org website feature on the game page, open to any visitor; it is not a separate API call. |

Considered and not used: inline keyboards for moves (clunky, the reason for the Mini App), board images per move (chat pollution), Telegram HTML5 Games (older and less capable than Mini Apps), message effects (private-chat only), reactions (no clear value once the chat is quiet).

## 10. Platform constraints that shape the design

| Constraint | Product implication |
|---|---|
| Interactive content only in Mini Apps | The board lives in the app; the chat gets cards and images only. |
| Inline `web_app` buttons don't work in groups | All app buttons in the group are direct links. |
| No member list; unknown usernames can't be resolved | In-app opponent picker shows known players; `/challenge @name` reaches anyone the bot has seen, and reply-to-message `/challenge` covers everyone else. |
| Bots can't DM without permission | Ask in the app on first launch; the app and the challenge mention cover users who decline. |
| Edits don't notify | Turn notifications are DMs and in-app, never group messages. |
| About 20 messages per minute per group | Irrelevant at this footprint; position shares are user-initiated and rate-limited per user (20 per minute, so several positions can be shared at once). |
| Privacy mode | The bot never sees ordinary chat; discussion of shared positions is just normal chat. |

## 11. Non-functional requirements

- **Latency**: a move is visible to the opponent and spectators in the app within 2 s (p95); the game card status edit within 5 s.
- **Availability**: 99.5 % monthly. Clocks and forfeits must be exact across restarts.
- **Scale target for v1**: 5,000 groups, 1,000 concurrent games, with headroom to grow 10×.
- **Data**: games kept indefinitely unless voided or anonymised on request; daily backups.
- **Mini App**: loads in under 2 s on a mid-range phone on 4G; works on iOS, Android, Desktop and Web Telegram clients.
- **Localisation**: strings externalised; English at launch.
- **Observability**: usage per group, move latency, Mini App load errors, Lichess import failures.

## 12. Success metrics

| Metric | Target after 3 months |
|---|---|
| Groups that complete a game in their first week | 60 % of groups that add the bot |
| Games completed (not abandoned or timed out without a move) | 75 % of games started |
| Median time from "your move" to move made | under 2 hours for 1-day controls |
| Spectator opens per game | 2+ |
| Positions shared per 10 games | 3+ |
| Weekly active groups after 4 weeks | 40 % of activated groups |
| Mini App move failures (drop not registered, app closed mid-drag) | under 1 % of moves |

## 13. Release plan

1. **Alpha (P0)**: challenges, rules and clocks, Mini App board with drag-and-drop and live updates, game cards, DM notifications, spectating, replay, position sharing, ratings and leaderboard, Lichess link, admin settings. Run in two or three friendly groups. Exit: 50 completed games, no rule bugs, drag reliability confirmed on iOS and Android.
2. **Beta (P1)**: board themes and piece sets, player filter in history, share to any chat, polish from alpha feedback. Public listing.
3. **Later, only if wanted**: faster clocks with both players live in the app, cross-group rating.

## 14. Open questions

1. **Confirm moves default.** Resolved: **Move confirmations** is a user setting (Always, Only against people, Never), default Only against people (§7.4).
2. **Close after moving.** Proposed default: the app closes and returns to the chat after a move. Confirm.
3. **Group mention fallback.** For users who decline DMs, allow admins to turn on a group mention after N hours without a move? Proposed: off, revisit after alpha.
4. **Board library and licence.** Confirmed: `chessground`, Lichess's own board library, is GPL-3.0-or-later; `react-chessboard` is a maintained MIT alternative. Decide in the tech doc.
5. **Lichess import.** Server-side import at game end (gives a permanent URL) versus a link that opens the Lichess import page with the PGN. Confirmed: `POST /api/import` returns a permanent URL immediately, unauthenticated, at 100 imports/hour (200/hour with an OAuth2 token). Decide in the tech doc whether the 5,000-group scale target needs an app token or a queued fallback for burst traffic.
6. **Rating scope.** Per group only (proposed), or also a cross-group rating.
7. **Name and handle.**
