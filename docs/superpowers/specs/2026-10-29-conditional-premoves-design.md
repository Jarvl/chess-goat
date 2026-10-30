# Conditional premoves

Status: draft for review, 2026-10-29. Replaces the blind premove chain of the
[premoves spec](./2026-09-24-premoves-design.md) everywhere. Changes the confirmation flow of the
[move confirmations spec](./2026-09-24-move-confirmations-design.md) where a move carries premoves.
The clickable mockup the behaviour was settled on is
[Conditional Premoves Prototype](https://claude.ai/artifact/5MwHTKpPfB9HLDY4nRieNP).

## Why

Group Chess is correspondence chess. A player who can see the next few moves coming wants to say
"if they play this, I play that" for each reply they expect, then put the phone down. Today's
premoves are a single blind chain: each premove fires against whatever the opponent plays, if it is
legal. That suits a recapture, but it cannot express "against …Nf6 I play Ng5, against …Bc5 I play
c3". Chess.com (Daily) and Lichess (correspondence) both offer conditional moves for this.

## Goals, non-goals, anti-goals

**Goals**

- A player builds a private tree of lines: an opponent move, the player's reply to it, then further
  opponent moves under that reply, as deep and as branchy as they like.
- The server plays the matching reply the moment the opponent moves, even with the app closed.
- The tree can be built on top of the player's own move before it is sent, and sent with it.
- Building it on a phone is quick and reads cleanly, even for long lines.

**Non-goals**

- Blind premoves. They are removed, not kept beside conditional ones.
- Showing anyone else the tree, during or after the game.
- Importing lines from PGN or an engine.

**Anti-goals** (would make it a failure even if it works)

- A premove that fires in a position the player never saw on the board.
- Losing a move or a premove the player confirmed, or playing one they did not.
- Leaking to the opponent, through timing or a version counter, that premoves exist.
- A tree view that turns into a staircase or runs off the screen on a phone.

## Approaches considered

1. **The tree in one column, sent whole (chosen).** One `bytea` column on `games` holds the tree in
   a compact binary form. `PUT /premoves` replaces it by compare-and-set against the tree the device
   last saw, as the chain is replaced today, and `POST /moves` can carry a tree with the move.
   Firing picks the opponent's branch and keeps its subtree. It reuses the row lock, the owner-only
   pushes and the multi-device check that premoves already have, and it matches the draft-then-
   Confirm flow, in which the device holds the whole tree anyway.
2. **A list of lines**, as Lichess stores its conditional moves. Rebuilding the tree from lines is
   cheap, but both the screen and the firing logic think in the tree, so the app would convert tree
   to lines on every save and the server lines to tree to check them. Two lists describing the same
   tree in a different order would also need sorting before the compare-and-set. Workable, but it
   stores a shape nothing uses directly.
3. **One row per move pair**, edited with small operations. Edits from two devices could merge
   instead of being refused, at the cost of a new table, an operations API and per-operation checks.
   Confirm sends a whole batch anyway, so it buys little.

The player chose 1.

## Behaviour

### The tree

- A tree hangs off a position where the **opponent** is to move. Each branch is a **pair**: an
  opponent move and the player's single reply to it. Under a reply hang further branches for the
  opponent's next move, and so on.
- Every move in the tree is **fully legal** in the position its line reaches. There is no pattern
  rule and no imagined position: each line names the opponent's exact moves, so every position is
  real.
- **One reply per opponent move.** Two branches at the same point never share an opponent move.
- **No size limit.** The only bound is the API's 64 KB request limit (`apps/server/src/api/app.ts`),
  a transport limit rather than a product rule: about 9,000 pairs in one tree, once base64-encoded.
  Requests carry the tree once (edits send a fingerprint of the old tree, not the tree itself), so
  the whole range can be edited. If a change would ever take a tree past it, the app keeps the
  change on screen and shows "This premove tree is too big to save. Remove some lines first."
  instead of sending it.
- The tree belongs to the player, not a device. Only its owner ever sees it.

### Building it

The board is live for **both** sides while a player builds premoves. Moves alternate as in a real
game: an opponent move, then the player's reply.

- **When.** On the player's own turn, once they have played their move (and before it is sent, when
  confirmations are on). On the opponent's turn, at any time. On the player's own turn before they
  have moved, touching an opponent piece shows the toast "Play your own move first. Then you can
  play the moves {opponent} might make."
- **Adding a line.** Play an opponent move, then the reply. The opponent move appears in the tree
  and the move strip as soon as it is played. Until it has a reply it is not counted as a premove,
  and it is dropped when the tree is confirmed or saved. It is never sent to the server.
- **Branching.** Go to any position in the tree (tap a move, or step with ◀ ▶) and play a different
  move there. A different opponent move adds a branch. Playing the opponent move that is already
  there just goes to it. There is no "add" button.
- **Replacing a reply.** Playing a different reply where one exists asks first, in the native
  popup: "Replace 4.Ng5 with 4.Nc3?", with "The 2 moves after Ng5 will be removed too." (or "The
  move after Ng5 …") when there are any. While the popup is open, the board, tree and move strip
  already show the new move. **Replace** keeps it; **Cancel** puts everything back exactly as it
  was.
- **Removing.** The selected premove (either side's) has a small ✕ right beside it, in both the
  Lines tree and the move strip. Tapping ✕ always asks: "Remove 3…Nf6?", "Remove 3…Nf6 and the move
  after it?" or "Remove 3…Nf6 and the 4 moves after it?". Remove takes the move and everything after
  it, and the toast "Removed 3…Nf6 and 4 moves after it" confirms it. Real moves, the player's own
  waiting move and earlier positions have no ✕.
- **Replacing the player's own waiting move.** From the position before it (◀ from the start of the
  tree), playing a different move replaces it. When premoves hang off it, this asks first: "Replace
  3.Bc4 with 3.d4?" with "Your 2 premoves after Bc4 will be removed too.", previewing it on the board
  as above. With no premoves it replaces without asking.
- **Promotion** opens the existing picker, for the opponent's moves in the tree as well as the
  player's.
- Remove and replace **always ask, whatever the Move confirmations setting**.

### Sending it: Move confirmations on

"Always", or "Only against people" in a game against a person.

- Every change is a **draft** until the player confirms. Nothing reaches the server before that.
- Telegram's bottom bar shows **Cancel** (SecondaryButton) and the MainButton:
  - **Confirm move + 2 premoves** on the player's turn ("Confirm move" with no premoves). The move's
    name is never in the button.
  - **Confirm premoves** on the opponent's turn.
  - Below Bot API 7.10 and in a plain browser, the in-page fallbacks of the confirmations spec apply.
- **Confirm move** sends the move and the tree in **one request**, so the tree is in place before
  the opponent (or the bot, about 200 ms later) can reply. **Confirm premoves** saves the tree.
- **Cancel** discards the draft: the waiting move and every premove change since the last save.
- The tab bar is hidden while a draft has changes. Leaving the game screen discards the draft, as for
  a waiting move today, but **asks first** while the draft has unconfirmed changes (the waiting move
  alone counts):
  - Telegram's BackButton and the Settings menu item go through the router, which asks with
    `confirmDialog`: "Leave this game?" with "Your premoves haven't been confirmed and will be lost."
    (or "Your move and premoves haven't been sent and will be lost." when a move is waiting; "Your
    move hasn't been sent and will be lost." when only a move is). Buttons **Stay** and a destructive
    **Leave**. Stay changes nothing.
  - Any other in-app navigation away from the game goes through the same check.
  - Closing the Mini App itself is Telegram's: while the draft has changes, `setClosingConfirmation`
    is on, so Telegram shows its own "changes may not be saved" prompt (its wording, not ours). It is
    off otherwise.
  - With confirmations off there is never a draft to lose, so none of this applies.
  - This replaces the move confirmations spec's "There is no close anyway? prompt" rule.
- **Minimising keeps the draft.** Collapsing the app (Telegram's `deactivated` event) no longer
  cancels anything: the waiting move and the premove draft are both still there when the player
  comes back. This replaces the minimise rule of the move confirmations spec, so `GameView`'s
  `onDeactivated` cancel goes.
- If the opponent moves, or the game ends, while a draft is open, the draft is discarded and the
  toast "{opponent} moved. Your unconfirmed premoves were discarded." shows when it held premove
  changes.

### Sending it: Move confirmations off

"Never", or "Only against people" in a bot game.

- The player's move sends on drop, as today. They build premoves on top of it once it is sent.
- Every completed change saves at once: a new pair once its reply is played, a replacement or a
  removal once its popup is confirmed. An opponent move waiting for its reply stays on the device.
- Saves run one at a time, and the board stays live during one, as premove saves do today.
- There is no Cancel/Confirm bar.

### Firing

Firing happens inside the move transaction, as today.

- When the opponent plays move **m** and the tree has a branch for **m**, its reply is played in the
  same transaction as a normal move: it resets the clock, lapses a draw offer by the opponent, and
  so on. The branch's subtree becomes the new tree. The owner gets no turn DM; the opponent gets the
  usual flow (card, turn DM, or the bot's reply).
- When **m** is not in the tree, the whole tree is cleared. The owner gets the usual turn DM with
  the extra line "Your premoves were cancelled." and, if the Mini App is open, the toast "Premoves
  cancelled". Bot games send no DM.
- When a line simply runs out (the reply fired and has no branches under it), nothing is cancelled
  and no extra line is sent.
- **Both players' trees.** A player can send a tree with their move while the opponent's tree is
  stored. When the opponent's reply fires, the mover's new tree is checked against it at once, and
  so on, so several moves can play in a row instantly, as on chess.com. Each fired move is a normal
  move with its own clock reset and waiting DM. Only the side left to move at the end gets a turn
  DM; the card is edited once (it is deduped).
- A fired reply that ends the game finishes it as any move does. A game that ends for any reason
  clears the tree.
- A reply fires even when a threefold or fifty-move claim was open to its owner, as today.
- A fired reply goes through the arbiter like any move. It is always legal, because the position it
  was chosen in is the real one; if the arbiter ever refused it, the tree is treated as missed.

### Privacy and several devices

Unchanged from the premoves spec:

- Only the owner's `GameDto` carries the tree. Opponents and spectators get the empty tree.
- A premove save never bumps `games.version` and is pushed to the owner's streams only.
- An edit made on a device showing an out-of-date tree is refused with `premoves_changed`; that
  device shows the toast "Premoves changed on another device" and reloads. Every (re)connect gets a
  snapshot.

### Launch

The migration drops the blind chains still queued in running games. They cannot be turned into
conditional lines. Their owners get the normal turn DM when the opponent moves, without the
"cancelled" line.

## The game screen

The layout follows today's game screen, top to bottom:

1. The opponent's player bar, the board, the player's player bar (unchanged).
2. **Move strip** (`MoveList`): the real moves, then the player's waiting move (outlined in the
   accent green), then the **premove line being viewed**: opponent moves in `--hint`, the player's
   as `--pm` chips, move numbers in `--pm`. The current move has the usual `aria-current` emphasis
   (`--pm` filled for the player's premoves, `--pm-soft` for the opponent's). The selected premove
   is followed by the ✕. Tapping a move goes to it. The strip keeps the current move, and its ✕,
   scrolled into view.
3. **Replay slider** (◀ slider ▶): one timeline from the start position through the real plies, the
   waiting move, then the premove line being viewed. The track is `--acc` up to the real position
   and `--pm` beyond it, and the knob turns `--pm` on a premove, as today.
   - The line being viewed is the path to the selected move, continued along the line last visited
     there and then along each first branch. Moving back along it and forward again returns to the
     same branch.
   - ◀ steps back through the premoves, then to the position before the waiting move, then through
     the game's history. Earlier positions are view-only: touching the board returns to where the
     player was. The position before the waiting move is the exception, where a different move
     replaces it (see Building it).
4. **Status line**: a pill, then one hint.
   - Pill: **Draft** when there are unconfirmed changes; otherwise **Your move**, **N premoves
     saved**, or **{opponent} to move**.
   - Hint: "Play your move"; "Play a move {opponent} might make"; "Your reply to Nf6"; "Play
     another of {opponent}'s moves to branch"; "Play another move to replace Ng5"; "Before your Bc4 ·
     play another move to replace it"; "An earlier move · tap the board to go back".
5. **Lines panel**: every branch at once.
   - A root chip first: **3.Bc4** with "your move" while a move waits, or **Now** with "current
     position". Tapping it goes to the start of the tree.
   - One block per line, in standard notation: `3…Nb4 4.d3 Nxd3+ 5.Bxd3 d6 6.Bc4 …`. A line runs on
     and wraps like text while it has a single continuation. Opponent moves are `--hint`, the
     player's are bold `--pm`, the selected move is filled `--pm` with the ✕ beside it.
   - Indentation only where the opponent has alternatives: the alternatives start new blocks under
     the move where they split, with a `--pm-sq` left rule. Indentation stops growing after three
     levels.
   - A move number never wraps away from its move (a `nowrap` move-and-number unit).
   - The panel scrolls on its own (about a third of the screen tall) and keeps the selected move in
     view. It must not trap scrolling: no `overscroll-behavior: contain`, so a swipe on a panel that
     cannot scroll further scrolls the page.
6. The Telegram bottom bar, or the tab bar.

The mockup also tried variations in brackets inside the move strip; the player found it more
cluttered than the Lines panel, so it is out.

## Data

Migration `0011_conditional_premoves`:

```sql
ALTER TABLE games ADD COLUMN premove_tree bytea NOT NULL DEFAULT ''::bytea;
UPDATE games SET premoves = '{}' WHERE premoves <> '{}';
```

Migrations run at boot and deploys may overlap old and new containers for a few seconds, so the old
`premoves` column is emptied but **not dropped** here: an old container still selecting it keeps
working until it stops. `schema.ts` stops using it. A migration in a later release drops it.

The owner is still the side **not** to move: a tree can only be stored while it is not its owner's
turn, and a tree that reaches its owner's turn is played or cleared in that transaction. An empty
`bytea` is "no tree". `schema.ts` replaces `premoves` with `premoveTree`.

### Encoding

One pure module, `packages/shared/src/chess/premoveTree.ts`, used by the server and the Mini App.

- **In memory:** `type PremoveNode = { move: string; reply: string; children: PremoveNode[] }`, with
  UCI strings. The Mini App's draft also allows `reply: null` for an unanswered opponent move;
  the encoder skips those nodes and everything under them.
- **Bytes:** a list is one count byte (0–218; no position has more legal moves) followed by its
  nodes in order. A node is its opponent move, its reply, then its children list. A move is two
  bytes, little-endian: from-square in bits 0–5 (a1 = 0 … h8 = 63), to-square in bits 6–11, promotion
  in bits 12–14 (0 none, 1 q, 2 r, 3 b, 4 n), bit 15 zero. Branch order is the order the player
  added them, which is also display order.
- **On the wire:** base64url without padding, in JSON string fields. Two trees are equal when their
  strings are equal.
- **Size:** measured on random trees from a middlegame position (pairs → bytes as base64url):
  15 → 0.1 KB, 100 → 0.7 KB, 1,000 → 6.5 KB, 3,000 → 19.5 KB. Nested JSON would be 4.5 times larger.
- Decoding needs no chess logic. A malformed string (bad base64, truncated, trailing bytes, bit 15
  set, promotion over 4) is a `validation` error.

## API

### `PUT /api/games/:id/premoves`

Body `PremoveTreeRequestSchema = { baseHash: string, tree: string, expectedPly: number }`. `tree` is
the tree the device wants. `baseHash` is the fingerprint of the tree the device last saw from the
server: SHA-256 of its bytes, base64url without padding (the empty tree hashes its empty bytes).
Sending a fingerprint instead of the old tree keeps every request to one tree, so a tree near the
request limit can still be edited. Players only. Returns the caller's `GameDto`.

| Check, in order | Error |
|---|---|
| The game is over | `stale_state` (from `lockActiveGame`) |
| It is the caller's turn | `not_your_turn` |
| `expectedPly !== plyCount` | `stale_state`, `{ plyCount }` |
| The stored tree's fingerprint is not `baseHash` | `stale_state`, `{ reason: 'premoves_changed' }` |
| `tree` does not decode | `validation` |
| A node not in the stored tree is illegal, or two siblings share an opponent move | `illegal_move`, `{ path }` (the UCI moves leading to it) |

- **Only new nodes are checked.** A node whose path, opponent move and reply all exist in the
  stored tree is already stored and checked. A normal edit therefore costs a few milliseconds whatever the tree's
  size (chess.js 1.4.0 takes about 0.17 ms per pair).
- **Check before the lock.** The route reads the game without locking it, compares the stored tree's
  fingerprint with `baseHash`, and checks `tree`'s new nodes against that stored tree from that
  position. It then takes the lock (`lockActiveGame`) and re-checks the ply and the fingerprint
  before writing. A large new tree is therefore never checked while the row is locked.
- **Never block the event loop for long.** A whole new tree of thousands of pairs takes seconds to
  check (about 1.5 s for 9,000). The check runs off the main thread or in slices that yield, so a big
  tree cannot stall the server.
- A `tree` equal to the stored one changes nothing and publishes nothing. Otherwise the tree is
  replaced, `version` is left alone, and the owner's streams get the new DTO.

### `POST /api/games/:id/moves`

`MoveRequestSchema` gains `premoveTree: string` (optional, default empty): the caller's tree for the
position after their move. It is checked in full against that position (computed from the
unlocked read plus the move) before the lock, like `PUT`. An invalid tree refuses the whole request
(`validation` or `illegal_move` with `{ path }`), so a move is never sent without the premoves it was
confirmed with. The device checks with the same shared code, so this should never be seen. A retried
request (same `clientMoveId`) returns the current state as today.

### Firing (`commitMove`)

`commitMove` takes the mover's new tree (empty when the request carried none). Two trees are in
play: **waiting**, the tree of the side that just moved (its branches are the next opponent moves),
and **toMove**, the tree stored on the row, which belongs to the side now to move (its branches are
moves the just-moved side might have played). After a move that does not end the game:

```
waiting = the mover's new tree
toMove  = the stored tree
last    = the move just played
loop:
  branch = branchFor(toMove, last)            // pure helper in premoveTree.ts
  if branch is null:
    if toMove is not empty: cancelled for the side to move (flag on their turn DM)
    store waiting as the row's tree; stop
  play branch.reply for the side to move, as a normal move,
    with clientMoveId = premove:<publicId>:<ply>; that side gets no turn DM
  if that move ended the game: finishGame (clears the tree); stop
  (waiting, toMove) = (branch.children, waiting)
  last = branch.reply
```

When it stops, the side to move gets the usual turn DM, card edit or engine enqueue. Every move in
between is a normal commit (move row, clock, draw-offer lapse, waiting DM). A move with no tree and
a stored tree that misses behaves exactly as today. Write it as a loop, not recursion: its length is
bounded only by the trees. The engine job's stall check (game active, engine to move, `plyCount`
equal to the job's ply) already covers several fired moves.

## DTO

`GameDto.premoves: string[]` becomes `premoveTree: string` (base64url, empty for everyone but the
owner). `GameDtoSchema` declares it `.default('')`. Server and Mini App ship in one image; an old
bundle still cached in a webview ignores the field, and its old-shape `PUT` gets `validation` and
reloads.

## DM

Unchanged: the turn DM's "Your premoves were cancelled." line, keyed by `premovesCancelledAtPly`.

## Mini App

`state/premoves.ts`, the premove parts of `state/game.ts`, `MoveList`, the replay slider and the
premove paths of `GameView` are rewritten. What has to hold:

- **Server state vs draft.** The store keeps the decoded server tree and a draft: the waiting move
  (or none), the draft tree (with unanswered opponent moves allowed), the selected path, the line
  being viewed, and the earlier ply being viewed (or none). A new ply or a game end clears the draft
  (see Sending it). A DTO from the server replaces the server tree; with confirmations on it never
  touches the draft until it is confirmed or discarded.
- **Board.** While building premoves, chessground's `movable.color` and `turnColor` are the side to
  move in the shown position, and `dests` are its full legal moves (chess.js). The shown move is
  highlighted with the existing `setHighlights`. Earlier positions are not movable.
- **Saving with confirmations on.** Confirm move: `POST /moves` with the move and the encoded draft
  tree. Confirm premoves: `PUT /premoves` with `baseHash` = the fingerprint of the server tree when
  the draft started. Failures follow the premoves spec (reload; `premoves_changed` toast; offline
  toast), except a request that would be over the size limit, which is never sent (see The tree), and
  a 413, which is handled the same way rather than reloading.
- **Saving with confirmations off.** Each completed change: `PUT /premoves`, one at a time, with
  `baseHash` = the fingerprint of the last tree the server confirmed, as `editPremoves` does today.
- **Notices.** `diffNotices` keeps `premove_played` and `premoves_cancelled`. Walk the moves after the
  previous ply against the previous tree: count a fired reply for each opponent move that matched a
  branch and was followed by its reply. `premoves_cancelled` when the walk stops on an opponent move
  that is not in a non-empty remaining tree while the game is active.
- **Popups** go through `confirmDialog` (native `showPopup`, in-page fallback). The board preview
  under the replace popup is a temporary change to the draft, restored on Cancel.
- **Copy** in `packages/shared/src/i18n/en.ts`: new keys for the button labels, status pill and
  hints, the replace and remove popups, the removed toast, the "play your own move first" toast and
  the "draft discarded" toast. `app.game.premove_remove_confirm*` change to the move-named forms
  above. `app.settings.move_confirmations_help` drops "Premoves never ask." and says premoves are
  confirmed with the move.

## Removed

- `packages/shared/src/chess/premove.ts` (the pattern rule, the imagined position,
  `checkPremoveChain`) and its tests; the Mini App's `premoveLabel` and premove-step logic.
- `PremovesRequestSchema`'s list shape. `games.premoves` stays declared in `schema.ts`, unused, and
  goes from the database in a later release (see Data).

## Testing

**Shared unit (`premoveTree.test.ts`):** round-trips (empty, deep, wide, promotions, castling);
every malformed-input case; new-node detection against a base; legality and duplicate-sibling errors
with their `path`; `branchFor`; the encoder skipping unanswered nodes.

**Server integration (`premoves.test.ts`, `api-premoves.test.ts`, rewritten):**
- `PUT` saves, replaces, clears; each row of the error table; an unchanged tree publishes nothing.
- `POST /moves` with a tree stores it atomically; an invalid tree refuses the move.
- Firing: a matching branch plays its reply and keeps the subtree; a miss clears with the flagged DM;
  a line that runs out sends no flag; bot games send no DM.
- Both trees: alternating replies play in one transaction, in order, with the right
  `clientMoveId`s and one turn DM at the end.
- Privacy: other viewers get `''`; no version bump; owner-only pushes; reconnect snapshot.
- A 9,000-pair tree is saved, then edited again; it is checked without holding the lock; a concurrent
  opponent move during the check yields `stale_state`.
- Game end of every kind clears the tree. The engine flow with a fired reply (extend
  `engine-move-flow.test.ts`).
- The migration empties queued chains and leaves the old column in place.

**Mini App unit:** the draft (add, branch, replace with preview and Cancel, remove, unanswered
opponent moves); the Lines layout (runs on, indents only at splits, caps at three levels, numbers stay
with moves); the timeline (indexes, the line being viewed, earlier plies, replacing the waiting move);
both confirmation modes; `diffNotices`.

**Playwright (`premove.spec.ts`, rewritten):** build a move plus two branches and confirm in one
request; a bot reply fires a premove; a miss shows the toast; Remove and Replace ask, and Cancel
restores the board; with confirmations off, each pair saves on its own; two pages as the same player
refuse the stale edit.

## Docs to update in the same change

- `docs/PRD.md` §7.4: premoves become conditional premoves.
- The technical design §2 and the premoves spec: point to this spec; mark the premoves spec
  superseded.

## Left to the builder

- Component and store structure, and how the Lines panel and the move strip share one model.
- How the pre-lock check is taken off the main thread (worker or yielding slices).
- CSS details beyond the tokens named here, matching the mockup.
- Haptics, following today's (light on a queued premove and a fired one, warning on a cancel).
