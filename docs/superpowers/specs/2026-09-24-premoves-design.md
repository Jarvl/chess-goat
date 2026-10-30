# Premoves

Status: superseded by [conditional premoves](./2026-10-29-conditional-premoves-design.md)
(2026-10-29). Was: accepted for planning, 2026-09-24. Implements the premove behaviour of the Chess Goat
prototype (`Chess Goat Prototype.dc.html`: `onPremoveSquare`, `firePremove`, `premoveBoard`, the
premove stepper and the premove chips in the move strip). The stepper later became part of the
game's one replay slider (see Slider). Replaces "No premoves" in §2 of the
[technical design](./2026-09-20-group-chess-technical-design.md). The prototype's Share Position
changes are not part of this spec.

## Why

A player who can see their reply coming wants to enter it now and put the phone down, not wait for
the opponent's move, then open the app again for a move they already chose. Premoves let them
queue a chain of moves while it is not their turn. The server plays each one the moment the
opponent's move lands, even with the app closed.

## Behaviour

- While it is the opponent's turn, a player can queue a **chain** of premoves. Each one is made on
  the **imagined position**: the real position with their earlier premoves applied.
- Queuing never asks for confirmation, whatever the Move confirmations setting says.
- A premove that promotes a pawn opens the usual promotion picker. The chosen piece is saved with
  the premove.
- Premoves are stored on the server. Only their owner can see them. The opponent and spectators
  cannot, not even when a premove is queued or removed.
- The chain belongs to the player, not to a device. Every device the owner has the game open on
  shows the same chain, and an edit on one shows up on the others straight away. Players often
  switch between phone and desktop mid-game.
- An edit made on a device showing an out-of-date chain is refused rather than merged, and that
  device shows the current chain. A chain can only play if some device showed it exactly as it
  is (see [Several devices](#several-devices)).
- When the opponent moves, the server checks the **first** premove against the real position.
  - **Legal:** the server plays it in the same transaction. It counts as a normal move: it resets
    the clock and makes an offer by the opponent lapse. The owner gets no turn DM. The opponent
    gets the usual flow, with the turn DM and card edit (or the bot's reply).
  - **Illegal:** that premove and every one after it are dropped. The owner gets the usual turn
    DM with an extra line, "Your premoves were cancelled." The Mini App shows a toast if it is
    open. Bot games send no DM, as they already don't (engine spec §8).
- One premove plays per opponent move. The rest of the chain waits for the next reply.
- The queue is emptied when the game ends for any reason. There is no limit on its length.
- Premoves work in bot games too. The bot's move triggers them the same way.

### Which squares a premove may target

Premoves use the **pattern rule**, as on Lichess. A piece may target any square its movement
pattern reaches from its square in the imagined position. The rule ignores blocking pieces, check,
and what occupies the target, because the opponent's move may change all of those before the
premove is checked for real.

| Piece | Targets |
|---|---|
| Pawn | One square forward; two forward from its start rank; one diagonally forward (either side), occupied or not |
| Knight | The eight L-shapes |
| Bishop, rook, queen | Every square on their lines to the board edge |
| King | The eight adjacent squares; plus castling, see below |

The only exception is the piece's own square. A target holding one of the player's own pieces is
allowed. The typical case is a recapture on a square the opponent is about to take.

**Castling.** The king may target g1/c1 (g8/c8 for Black) when it stands on e1 (e8) in the imagined
position, a rook of the same colour stands on h1/a1 (h8/a8), and the real position's castling
rights for that side survive the chain. Any earlier premove from or to e1, a1 or h1 (or the
matching Black squares) removes the rights it touches.

**Promotion.** A pawn target on the last rank requires a promotion piece (`q`, `r`, `b`, `n`). No
other premove may carry one.

**The imagined position** comes from applying each premove in turn:
- The piece moves from `from` to `to`, replacing whatever was on `to`.
- A promotion puts the chosen piece on `to`.
- A king moving two files from its start square also moves that side's rook, as in castling.
- There is no en passant removal. A pawn premoved diagonally to an empty square just moves there.
- An entry whose `from` square no longer holds one of the owner's pieces is skipped. This happens
  when the opponent captured that piece after an earlier premove fired. The entry stays in the
  chain, shows as its raw UCI, and cancels the chain when its turn comes, with the flagged turn DM.

The imagined position can be illegal as chess, and that is expected. It is only a board layout.
Premoves are checked properly, with the arbiter, when they fire.

The pattern rule and the imagined position live in one pure module,
`packages/shared/src/chess/premove.ts`, which uses no chess.js. The server validates with it and
the Mini App offers targets with it, so a square the board accepts is always one the server
accepts.

## Server

### Data

Migration `0004_premoves` adds:

```sql
ALTER TABLE games ADD COLUMN premoves text[] NOT NULL DEFAULT '{}';
```

`premoves` is an ordered list of UCI strings (`e7e5`, `e2e1q`). Its owner is always the side
**not** to move. A premove can only be queued when it is not your turn, and a queue that reaches
its owner's turn is played or cleared in that same transaction. So the owner does not need its own
column.

`schema.ts` adds the column to `games`. The row is already locked `FOR UPDATE` by every
transaction that touches premoves, so no new locking is needed.

### API

`PUT /api/games/:id/premoves` is the one premove route, for the game's players only. Its body is
`PremovesRequestSchema = { base: string[], premoves: string[], expectedPly }`, where each entry is
a UCI string:

- `base` is the queue the device was showing when the player made the edit.
- `premoves` is the queue the device wants.

The device builds `premoves` from `base`. Queuing is `[...base, uci]`, Remove on step k is
`base.slice(0, k - 1)`, and clearing is `[]`. The server accepts any list that passes the checks,
so no separate append and truncate routes are needed.

The route locks the row with `lockActiveGame`, so a deadline that has passed forfeits first, as it
does for every other action. It returns the caller's `GameDto`.

| Check, in order | Error |
|---|---|
| The game is over | `stale_state` (from `lockActiveGame`) |
| It is the caller's turn | `not_your_turn` (they should make the move instead) |
| `expectedPly !== plyCount` | `stale_state`, `{ plyCount }` |
| The stored queue is not exactly `base` | `stale_state`, `{ reason: 'premoves_changed' }` |
| From the first index where `premoves` differs from `base`: some `from` does not hold the caller's piece in the imagined position, the pattern rule does not reach `to`, or the promotion suffix is missing or not allowed | `illegal_move`, `{ index }` |

The unchanged prefix is not checked again. It is the stored chain, and it was accepted when it was
stored. Checking it again would refuse every edit to a chain whose leftover went stale when the
opponent captured a piece, although that chain is still cancelled with the flagged DM at its own
turn. A fired premove leaves the rest of the chain untouched.

If every check passes, the queue is replaced with `premoves`. A request whose `premoves` equals the
stored queue changes nothing and publishes nothing.

There is no length limit. The only bound is the API's existing 64 KB body limit, which allows
thousands of premoves, and it is a transport limit, not a product rule.

**The route never bumps `games.version`, and it publishes to the owner only** (see below). A
publish to the whole game would push an event to every open stream, the opponent's included. Even
with nothing visible in its DTO, the event's timing would show when the other player premoves.

### Several devices

The server's queue is the only source of truth. No device owns the chain. Every device shows the
server's list, and every edit is a compare-and-set against the list that device was showing
(`base`).

**Why compare-and-set, and not last write wins.** Suppose your phone shows `[Nf6]` and you queue
`e5` after it. Meanwhile your laptop has removed `Nf6` and queued `d5`. With last write wins, the
server would store a chain no device ever showed. With compare-and-set, the phone's request is
refused, and a premove chosen in one imagined position is never played in another.

The comparison uses the list itself, not a revision counter. That needs no extra column. It also
leaves nothing that could leak to the opponent through a counter that shows how often the other
player edited.

**Pushes to the owner only.** `Bus.publish(gameId, audience?)` gains an optional
`{ userId }` audience. Every SSE listener in `routes/events.ts` already knows its `user.id`, and
skips a publish meant for another user. A premove edit publishes with the owner as the audience,
so each of the owner's open streams (up to four, spec §7.8) receives the new DTO at once. The
opponent's and spectators' streams receive nothing. Moves, including premoves that fire, still
publish to everyone, as now.

**Reconnects.** `routes/events.ts` currently skips the first snapshot when
`Last-Event-ID ≥ version`. Premove edits don't change `version`, so a device whose stream dropped
during an edit would keep the old queue. The route now always sends a snapshot on every
(re)connect, at the cost of one DTO query per connect. A device that opens the game fresh already
gets the queue from `GET /api/games/:id`.

### Firing: inside the move transaction

`playMove`'s transaction body is split out as `commitMove(tx, locked, colour, uci, clientMoveId)`.
It does everything the body does today: insert the move row, update the game, finish it if the
move ended it, and handle the card, DM and engine enqueue. It also takes `notifyOpponent` and
`premovesCancelled` flags (described below). `playMove` becomes the lock, the idempotency check,
the ply and turn checks, then `commitMove`.

After `commitMove` plays a move by X and the game continues, it looks at the queue, which belongs
to X's opponent Y:

1. **Empty:** the side effects are unchanged: card edit and Y's turn DM, or the engine enqueue.
2. **First premove legal** (arbiter `applyMove` on the real position and position keys): skip Y's
   turn DM. The card edit still happens because it is deduped per game. Remove the first premove
   and call `commitMove` again for Y with that UCI and
   `clientMoveId = premove:<publicId>:<ply>`. That inner call does X's side effects: the deadline,
   the reminder, the card, X's turn DM or the engine enqueue, and a lapse of any offer by X. It
   also checks the queue again, which is now empty for X, so the recursion is at most one level
   deep.
3. **First premove illegal:** clear the queue. Y's turn DM is enqueued with
   `premovesCancelled: true`, keeping the same dedup key `dm:<Y>:g:<id>:turn:<ply>`. In a bot
   game, where no turn DM is sent, the queue is still cleared and the Mini App toast is the only
   notice.

If a premove ends the game (checkmate, stalemate, a fivefold or 75-move draw, insufficient
material), `finishGame` runs as for any other move. `finishGame` sets `premoves = '{}'`. A normal
move by the queue's owner also clears the queue as a safeguard, although the invariant above says
that cannot happen.

A premove plays even when a threefold or 50-move claim was open to its owner. Premoving means
committing to the move.

`bus.publish` is called once at the end of `playMove`, as now. The opponent's client gets both
moves in one snapshot.

### Engine job

After `playMove`, the `engine_move` handler checks whether the engine is still to move and treats
yes as a stall, which leads to retries and eventually an abort. When the human's premove fires
inside the engine's `playMove`, the engine is to move again at a later ply, and the
`engine_move` job for that ply (deduped per ply) is already enqueued. The check becomes: **the
game is active, the engine is to move, and `plyCount` still equals the ply this job was started
for.**

### DTO

`GameDto` gains `premoves: string[]`. It holds the viewer's own queue when the viewer is the
player not to move, and `[]` for everyone else, spectators included. `buildGameDto` fills it
from `game.premoves`. `GameDtoSchema` declares it `.default([])` so older payloads still parse.

### DM

The `send_dm` payload schema in `jobs/handlers/telegram.ts` gains
`premovesCancelled: z.boolean().optional()`. When it is true, the turn DM text is followed by a
blank line and `t('dm.premoves_cancelled')`. The buttons are unchanged.

## Mini App

### State

`GameStore` gains:

- `premoves: Signal<string[]>`: the DTO's queue, including optimistic appends and truncations.
- `premoveStep: Signal<number | null>`: `null` is the end of the chain, `0` is the current
  position, and `k` is the position after premove `k`.
- `premoveOpen` (computed): the game is active, the viewer is a player, it is not their turn,
  and no move is pending. It holds while an earlier ply is shown.
- `premoveMode` (computed): `premoveOpen`, on the latest ply (`isLatest`).
- `timelineEnd` and `timelineAt` (computed), and `viewTimeline(i)`: the one slider's range and
  position (see Slider). `timelineEnd` is `plyCount`, plus the queue's length while
  `premoveOpen`. `timelineAt` is `plyCount + shownStep` in premove mode and the shown ply
  otherwise.
- `boardView` (computed): in premove mode, the imagined position after `premoveStep ?? n`
  premoves, with the real last move highlighted. Otherwise it is `position`. `position` itself
  stays the real position, so the clock, check haptics, Share (which sends the real ply) and
  `sideToMove` are unaffected.
- `premoveSquares` (computed): `[from, to]` of the premove being viewed, or `null` at step 0 and
  outside premove mode.
- `dests`: in premove mode at the end of the chain, the pattern-rule targets for the viewer's
  pieces on the imagined position. It is empty at earlier steps. Outside premove mode it is
  unchanged.
- `canMove`: true in premove mode at the end of the chain, as well as on the viewer's turn.

`apply(next)` also treats a DTO whose `premoves` differ from the current ones as new. The premove
route and the owner-only pushes return a DTO with the same version, and this is what lets it
through. A DTO from the server always replaces the local queue. An optimistic edit only lasts
until its own request settles or the server's list arrives.

When `plyCount` moves on, `premoveStep` resets to `null`. When a new queue is shorter than the
step being viewed, for example after Remove on another device, `premoveStep` clamps to the new
end.

`state/premoves.ts` holds the Mini App's pure helpers: the chip label for each premove, built from
the imagined position before it (`Nf3`, `Nxf3`, `exd5`, `e8=Q`, `O-O`), and the diff checks used
below.

### Board

Premoves use chessground's normal `movable` path, not its `premovable`:

- `premovable` holds a single premove, and setting another replaces it.
- Its targets would come from chessground's own copy of the pattern rule and could disagree with
  the server's.
- It expects the page to play the premove when the turn changes. Ours plays on the server.

In premove mode the board is given the imagined position, `turnColor` = the viewer, and
`movable = { colour: viewer, dests: premove dests }`.

- `BoardAdapter` gains `setHighlights(squares: string[])`, which draws the viewed premove's two
  squares in `--pm-sq`. The implementation uses chessground's `highlight.custom` if 9.2 has it.
  If it doesn't, the fallback is a CSS class on the matching `square` elements.
- The board wrapper gets a `premove` class in premove mode, which turns the destination dots
  `--pm` blue.
- A tap on the board while viewing an earlier step (`premoveStep !== null`) moves the view to the
  end of the chain, as in the prototype. Pieces cannot be lifted there.

### Queuing (`GameView.onDrop`)

On the viewer's turn, a drop goes through the move machine, unchanged. In premove mode:

1. If the drop is a promotion (pawn to the last rank), the existing picker opens. Cancelling it
   restores the board.
2. With `base` as the queue currently shown, the store's queue becomes `[...base, uci]`
   optimistically, and `PUT /premoves` is sent with `{ base, premoves: [...base, uci],
   expectedPly: plyCount }`.
   - **Saves run one at a time, and the board stays live during one.** A premove or Remove made
     while a save is running goes on screen at once. When the save settles, the next `PUT` sends
     the chain the player now wants, with `base` set to the chain the previous save confirmed,
     which is the chain that edit was made on. A change from another device in between is still
     refused, never overwritten.
   - While a save runs, a same-ply state from the server (such as the save's own echo) leaves the
     unsaved chain on screen. A new ply or a game end clears it.
   - A player can make premoves back to back; none waits on the network, and none is dropped.
3. On success, `applyState(dto)` runs. On failure, every unsaved edit is dropped and the game
   reloads.
   - A network failure also shows the offline toast.
   - A `stale_state` with `reason: 'premoves_changed'` means another device edited the chain
     first. It shows `toast(t('app.game.premoves_changed'))`. The reload (usually preceded by the
     owner push) shows the current chain.
   - Any other `stale_state` usually means the opponent moved first, and the reload shows the
     result.

A successful queue plays the light haptic. No Telegram button is shown and no confirmation is
asked.

### Move strip (`MoveList`)

While `premoveOpen`, after the real moves, each premove adds a hint-coloured `…` for the opponent's
reply and then a chip with the premove's label. Move numbers continue across both.

- A chip is outlined in `--pm` with `--pm` text. The chip for the step being viewed is filled
  `--pm` with white text.
- Tapping a chip views that step, from an earlier ply too. Tapping the last real move views
  step 0. That move loses its current-move emphasis while a premove is being viewed.
- The chip being viewed is followed by a small ✕ (`--pm` on `--pm-soft`), the only Remove. It
  asks first, in the native popup with a destructive Remove: "Remove this premove?", "… and the
  next one?" or "… and the {n} after it?". Confirmed, it sends `PUT /premoves` with
  `premoves: base.slice(0, k - 1)`, truncates the queue optimistically, and moves the view to
  step k−1. Failures are handled as for queuing.
- The strip scrolls to its end when a premove is added.

### Slider (`GameView` replay controls)

There is no separate premove stepper. The game's one replay slider runs from the start position
through the real plies and, while `premoveOpen`, on through the queue: index `plyCount + k` is
premove step k, and `plyCount` itself is step 0, the real position. It stands at the chain's end
by default, as the board does. ◀ and ▶ step through the whole range.

- An earlier ply keeps the premove stretch on the slider (and the chips in the strip), so the
  track keeps its scale while dragging across it; sliding back past the last real move returns
  to the chain.
- The track is drawn in CSS: `--acc` up to the real position, `--pm` from there to the knob when a
  premove is shown, then the empty track. The knob is `--pm` on a premove and `--acc` otherwise.
- Every change of position plays the selection haptic.

### Notices

`diffNotices` gains `premove_played` and `premoves_cancelled`. They are checked when `plyCount`
went up, the game is still active, and the previous chain was not empty.

- **Counting what fired.** `fired` is how many previous premoves played in a row: the move at
  `prev.plyCount + 2 + 2i` is `prev.premoves[i]`. It is counted rather than assumed, because a
  resumed app can receive several plies in one state.
- **`premove_played`** fires when `fired ≥ 1`, with the light haptic. The existing `opponent_moved`
  needs the viewer to be on move, and after a premove fires they are not.
- **`premoves_cancelled`** fires when `next.premoves.length < prev.premoves.length - fired`.
  `GameView` shows `toast(t('app.game.premoves_cancelled'))` and `tg.hapticNotify('warning')`.

Premove mode is also off while the player's own move is still sending or retrying
(`GameStore.moveBusy`).

### Theme

`styles.css` and `tg/theme.ts` gain `--pm`, `--pm-sq` and `--pm-soft`, taken from the prototype:

| Token | Light | Dark |
|---|---|---|
| `--pm` | `#2481cc` | `#6ab2f2` |
| `--pm-sq` | `rgba(36,129,204,.42)` | `rgba(106,178,242,.45)` |
| `--pm-soft` | `#e6f1fa` | `rgba(106,178,242,.14)` |

The Remove button uses the `--pm-soft` background with `--pm` text.

## Copy

`packages/shared/src/i18n/en.ts`:

| Key | Text |
|---|---|
| `dm.premoves_cancelled` | `Your premoves were cancelled.` |
| `app.game.premoves_cancelled` | `Premoves cancelled` |
| `app.game.premoves_changed` | `Premoves changed on another device` |
| `app.game.premove_current` | `Current position` |
| `app.game.premove_step` | `Premove {k} of {n}` |
| `app.game.premove_remove` | `Remove` |
| `app.game.premove_prev` | `Previous premove` (aria label) |
| `app.game.premove_next` | `Next premove` (aria label) |
| `app.settings.move_confirmations_help` | Appends ` Premoves never ask.` |

## Rollout

- Migration 0004 only adds a column with a default, so it is safe to run ahead of the code.
- The server and Mini App ship in one image and deploy together.
- An old Mini App bundle still in a webview cache ignores `premoves`. The schema default covers
  payloads from before the change.
- There is no feature flag.

## Out of scope

- Premoving while a move waits for Confirm move. That can't happen, because it is then the
  player's own turn.
- Reordering or editing a premove in the middle of the chain. Remove, then queue it again.
- Merging concurrent edits from two devices. The later edit is refused, and its device shows the
  current chain.
- Share Position changes from the same prototype revision.
- Metrics.

## Testing

**Shared unit (`packages/shared`), `premove.test.ts`:**
- The pattern targets for each piece, which ignore blockers and include own-occupied targets.
- Pawn diagonals to empty squares.
- Castling: allowed and blocked by lost rights, a moved king or a missing rook.
- Promotion suffix rules.
- The imagined position through a chain, covering capture-overwrite, promotion and castling rook
  moves.

**Server integration (`apps/server/test/integration/premoves.test.ts`):**
- Queue, truncate and clear through `PUT`.
- Each rejection in the table, including a stale `base` and an illegal entry partway through a
  chain (`index`).
- A long chain (50 premoves) is accepted.
- An unchanged `premoves` publishes nothing.
- A legal premove fires. The owner gets no turn DM and X does. The moves are ordered correctly
  with the right `clientMoveId`.
- An illegal premove clears the queue and enqueues the flagged DM. A bot game gets no DM.
- Privacy:
  - The opponent's and a spectator's DTOs show `[]`.
  - A premove edit never bumps the version.
  - A premove edit reaches the owner's SSE streams, and the opponent's and spectators' streams
    get no event.
- Several devices:
  - Two owner streams both receive an edit made through one of them.
  - A reconnect with `Last-Event-ID` equal to the version still gets a snapshot with the current
    queue.
- `LocalBus`: a publish with an audience reaches only that user's listeners, and one without an
  audience reaches all of them (unit).
- A premove that checkmates finishes the game. Resign, abort, timeout and void clear the queue.
- A premove fires after the engine's move. The engine job does not report a stall and the next
  `engine_move` is enqueued. Extend `engine-move-flow.test.ts`.

**Mini App unit:**
- Store:
  - Premove mode, steps and `boardView`.
  - Dests at the end of the chain versus earlier steps.
  - `apply` on a changed `premoves`.
  - A server list replacing an optimistic one.
  - `premoveStep` clamping when the queue shrinks.
- `diffNotices` `premoves_cancelled`, fired and cancelled.
- Chip labels.
- `MoveList` chips and `…`.
- `PremoveBar` stepping and Remove.
- The optimistic append and rollback in `GameView`, including the `premoves_changed` toast.

**Playwright (`apps/miniapp/e2e/premove.spec.ts`):**
- Queue two premoves on the opponent's turn with no confirm buttons, even with confirmations set
  to Always.
- Step back and forth, and Remove the second.
- The opponent's move over SSE plays the first.
- A cancelled chain shows the toast.
- Two pages as the same player: a premove queued on one appears on the other, and an edit from
  the stale page is refused with the `premoves_changed` toast.

## Docs to update in the same change

- `docs/PRD.md` §7.4: "Who can move" gains the premove exception, and a **Premoves** bullet
  summarises the Behaviour section.
- `docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` §2: "No premoves" points to
  this spec.
