# Conditional Premoves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind premove chain with a private tree of conditional premoves ("if they play X, I play Y"), built on the board, confirmed together with the player's move, and fired by the server inside the move transaction.

**Architecture:** One pure shared module (`premoveTree.ts`) owns the tree type, a 2-byte-per-move binary codec, the SHA-256 fingerprint, the legality check and branch lookup; the server stores the tree as `bytea` on `games`, checks new nodes before taking the row lock, and fires matching replies in a loop inside `commitMove`. The Mini App keeps a local draft (pure modules for the tree edits, the Lines layout and the timeline), renders a Lines panel plus the existing move strip and slider, and sends the draft with Confirm (or per change when confirmations are off).

**Tech Stack:** TypeScript, zod 4, chess.js 1.4.0, Hono, Drizzle 0.45 + PostgreSQL 18, Preact + @preact/signals, chessground 9, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-conditional-premoves-design.md` (read it before any task). Mockup the behaviour was settled on: https://claude.ai/artifact/5MwHTKpPfB9HLDY4nRieNP

## Global Constraints

- A pair is an opponent move plus the owner's single reply; two siblings never share an opponent move; every move is fully legal in its line's position (no pattern rule).
- Move encoding: 2 bytes little-endian, from-square bits 0–5 (a1 = 0 … h8 = 63), to-square bits 6–11, promotion bits 12–14 (0 none, 1 q, 2 r, 3 b, 4 n), bit 15 zero. A list is one count byte (0–218) then its nodes; a node is move, reply, children list. Branch order = insertion order.
- Wire form: base64url without padding. Fingerprint: SHA-256 of the tree's bytes, base64url without padding (43 chars); the empty tree hashes its empty bytes.
- No product size limit. The client never sends a tree whose base64url text exceeds `PREMOVE_TREE_MAX_CHARS = 60_000` (the API body limit stays 64 KB, `apps/server/src/api/app.ts:49`).
- The owner of the stored tree is always the side not to move. Premove saves never bump `games.version` and publish to the owner only.
- `games.premoves` stays in the database and in `schema.ts` (unused) for this release; a later release drops it.
- Remove and replace always ask first, whatever the Move confirmations setting. Minimising never discards anything.
- Copy is exact as given in the tasks; `{name}` is the opponent's display name, `{move}` a numbered SAN like `4.Ng5` or `3…Nf6`.
- Commands: `pnpm lint && pnpm format:check && pnpm typecheck` before each commit; server integration tests need `TEST_DATABASE_URL` (`scripts/local-postgres.sh start`).

## Review Focus

- Both players have trees and replies keep matching: every fired move must be committed in order with its own clock reset, and only the final side to move gets a turn DM (Task 4 test "plays alternating trees until one misses").
- The opponent moves while the player has an unconfirmed draft open: the draft is discarded with the toast, never sent against the new position (Task 10 test "discards an open draft when the opponent moves").
- A device edits a tree near the size limit: the save is never sent and the change stays on screen; a 413 is treated the same, never as a reload (Task 10 test "keeps an oversize change on screen").
- A promotion inside the tree, for either side, round-trips through codec, check and firing (Task 1 test "round-trips promotions and castling", Task 4 test "fires a promoting reply").
- A retried `POST /moves` (same `clientMoveId`) after its tree already fired returns the current state and does not re-check or re-store the tree (Task 4 test "returns the current state for a retried move with a tree").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/chess/premoveTree.ts` (create) | Tree types, codec, base64url, fingerprint, `branchFor`, legality check (generator + sync wrapper), counts |
| `packages/shared/src/protocol/requests.ts`, `dto.ts` (modify) | `PremoveTreeRequestSchema`, `MoveRequestSchema.premoveTree`, `GameDto.premoveTree` |
| `apps/server/drizzle/0011_conditional_premoves.sql` (create) | Add `premove_tree`, empty `premoves` |
| `apps/server/src/db/schema.ts` (modify) | `premoveTree` bytea column; `premoves` kept, marked unused |
| `apps/server/src/domain/premoves.ts` (rewrite) | `setPremoveTree`, `checkTreeYielding` |
| `apps/server/src/domain/games.ts` (modify) | Firing loop in `commitMove`; `playMove` accepts and pre-checks `premoveTree` |
| `apps/server/src/domain/gameDto.ts` (modify) | `premoveTree` for the owner |
| `apps/miniapp/src/state/premoveDraft.ts` (create) | Pure draft edits: play, remove, navigate, positions, counts |
| `apps/miniapp/src/state/premoveLines.ts` (create) | Pure Lines layout model |
| `apps/miniapp/src/state/premoveTimeline.ts` (create) | Pure timeline model (real plies, waiting move, viewed line) |
| `apps/miniapp/src/state/game.ts` (modify) | Store: server tree, draft, selection, timeline, board view, notices |
| `apps/miniapp/src/ui/game/LinesPanel.tsx` (create) | The Lines panel |
| `apps/miniapp/src/ui/game/MoveList.tsx` (rewrite premove part) | Strip with the viewed premove line and ✕ |
| `apps/miniapp/src/ui/game/GameView.tsx` (modify) | Building, confirming, saving, popups, toasts, leave guard wiring |
| `apps/miniapp/src/state/moveMachine.ts` (modify) | `confirm` carries the tree; `replace` event |
| `apps/miniapp/src/router.ts`, `boot.ts`, `ui/dialog.tsx` (modify) | Leave guard; `confirmDialog` `title`/`cancelLabel` |
| `packages/shared/src/i18n/en.ts` (modify) | Copy |

---

### Task 1: Shared premove tree module

**Files:**
- Create: `packages/shared/src/chess/premoveTree.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './chess/premoveTree';`)
- Test: `packages/shared/test/chess/premoveTree.test.ts`

**Interfaces:**
- Produces:
  - `type PremoveNode = { move: string; reply: string; children: PremoveNode[] }`
  - `type DraftNode = { move: string; reply: string | null; children: DraftNode[] }`
  - `class PremoveTreeFormatError extends Error`
  - `encodePremoveBytes(tree: readonly DraftNode[]): Uint8Array` — skips nodes whose `reply` is null, and everything under them
  - `decodePremoveBytes(bytes: Uint8Array): PremoveNode[]` — throws `PremoveTreeFormatError`
  - `toBase64Url(bytes: Uint8Array): string`, `fromBase64Url(text: string): Uint8Array` (throws `PremoveTreeFormatError` on characters outside `[A-Za-z0-9_-]` or length ≡ 1 mod 4)
  - `encodePremoveTree(tree: readonly DraftNode[]): string`, `decodePremoveTree(text: string): PremoveNode[]`
  - `premoveTreeHash(bytes: Uint8Array): Promise<string>` — `globalThis.crypto.subtle.digest('SHA-256', …)` → base64url
  - `branchFor(tree: readonly PremoveNode[], uci: string): PremoveNode | null`
  - `countPremovePairs(tree: readonly DraftNode[]): number` — nodes with a reply, recursively
  - `type TreeCheck = { ok: true } | { ok: false; path: string[] }`
  - `premoveTreeCheck(fen: string, tree: readonly PremoveNode[], known?: readonly PremoveNode[]): Generator<void, TreeCheck>` — yields once per node checked; a node whose path, move and reply all exist in `known` is skipped with its subtree compared recursively against `known`'s subtree; `path` is the UCIs leading to and including the bad move
  - `checkPremoveTree(fen, tree, known?): TreeCheck` — drains the generator
  - `PREMOVE_TREE_MAX_CHARS = 60_000`

- [ ] **Step 1: Write the failing tests** in `premoveTree.test.ts` (use `INITIAL_FEN` and the ITALIAN FEN `r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4` for castling):
  - `encodes a move in two bytes`: `encodePremoveBytes([{ move: 'e2e4', reply: 'e7e5', children: [] }])` equals `Uint8Array.of(1, 12, 7, 52, 9, 0)` (count 1; e2=12,e4=28 → `12 | 28<<6` = 1804 → `12, 7`; e7=52,e5=36 → `52 | 36<<6` = 2356 → `52, 9`; children count 0).
  - `round-trips an empty, a deep and a wide tree` through bytes and through base64url (`decode(encode(t))` deep-equals `t`; empty tree encodes to `Uint8Array.of(0)`).
  - `round-trips promotions and castling`: `{ move: 'a2a1q', reply: 'e1g1', … }` style nodes survive both directions.
  - `skips unanswered nodes`: `[{ move:'e7e5', reply:null, children:[…] }, { move:'d7d5', reply:'e4d5', children:[] }]` decodes to only the d5 node.
  - `rejects malformed input` with `PremoveTreeFormatError`: truncated bytes, trailing bytes, bit 15 set, promotion code 5, count above 218, bad base64url characters (`'a+b'`), and `fromBase64Url('a')`.
  - `fingerprints bytes`: `await premoveTreeHash(new Uint8Array())` equals `'47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'`; result length 43 for any input.
  - `finds a branch`: `branchFor(tree, 'd7d5')` returns that node; unknown move → `null`.
  - `counts pairs`: a tree with 3 answered and 1 unanswered node → `3`.
  - `checks every new move in its own position`: from the position after `1.e4` (`rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1`), `[{ move:'e7e5', reply:'g1f3', children:[{ move:'b8c6', reply:'f1b5', children:[] }] }]` → `{ ok: true }`; changing the deep reply to `'f1b6'` → `{ ok: false, path: ['e7e5','g1f3','b8c6','f1b6'] }`.
  - `refuses duplicate siblings`: two root nodes with move `'e7e5'` → `{ ok: false, path: ['e7e5'] }`.
  - `refuses moves after a mate`: a reply that mates with children → `ok: false` at the first child.
  - `skips nodes already in known`: with `known` equal to the tree except one new deep node, the generator yields exactly 1 time for a new pair (count yields; known nodes yield 0).
- [ ] **Step 2: Run them to see them fail**
  Run: `pnpm --filter @group-chess/shared test -- premoveTree`
  Expected: FAIL, module not found.
- [ ] **Step 3: Implement `premoveTree.ts`** per the Interfaces block. Squares as in the constraint; use chess.js `new Chess(fen).move({ from, to, promotion })` (throws on illegal) for the check, not `applyMove` (no repetition keys needed). Yield once per pair checked (after both moves of a new node).
- [ ] **Step 4: Run the tests to see them pass**
  Run: `pnpm --filter @group-chess/shared test -- premoveTree`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "Shared: conditional premove tree codec, fingerprint and check"`

### Task 2: Protocol schemas

**Files:**
- Modify: `packages/shared/src/protocol/requests.ts`, `packages/shared/src/protocol/dto.ts`
- Test: `packages/shared/test/protocol/requests.test.ts`, `packages/shared/test/protocol/dto.test.ts`

**Interfaces:**
- Produces:
  - `PremoveTreeTextSchema = z.string().regex(/^[A-Za-z0-9_-]*$/)`
  - `PremoveTreeRequestSchema = z.object({ baseHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), tree: PremoveTreeTextSchema, expectedPly: z.number().int().min(0) })`, type `PremoveTreeRequest`
  - `MoveRequestSchema` gains `premoveTree: PremoveTreeTextSchema.default('')`
  - `GameDtoSchema` gains `premoveTree: PremoveTreeTextSchema.default('')` (doc comment: the viewer's own tree while it is not their turn; `''` for everyone else). `premoves` and `PremovesRequestSchema` stay until Task 12.

- [ ] **Step 1: Write the failing tests**: `PremoveTreeRequestSchema` accepts a 43-char hash and `tree: ''`, rejects a 42-char hash, a `+` in `tree`, a missing `expectedPly`; `MoveRequestSchema.parse({ uci:'e2e4', expectedPly:0, clientMoveId:'abcdefgh' }).premoveTree === ''`; `GameDtoSchema.parse(activeGame).premoveTree === ''` and a sent `'AQwH'` is kept.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/shared test -- protocol` — Expected: FAIL.
- [ ] **Step 3: Add the schemas** as above.
- [ ] **Step 4: Run** the same command — Expected: PASS; `pnpm typecheck` passes.
- [ ] **Step 5: Commit** `git commit -m "Protocol: premove tree request, move request and DTO fields"`

### Task 3: Server storage, DTO and `PUT /premoves`

**Files:**
- Create: `apps/server/drizzle/0011_conditional_premoves.sql` (+ journal and snapshot via `pnpm --filter @group-chess/server db:generate`)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/domain/gameDto.ts`, `apps/server/src/domain/premoves.ts`, `apps/server/src/api/routes/games.ts`, `apps/server/src/domain/games.ts` (`finishGame` clears `premoveTree` as well as `premoves`)
- Test: `apps/server/test/integration/api-premoves.test.ts` (rewrite), `apps/server/test/integration/premoves.test.ts` (storage/visibility block only)

**Interfaces:**
- Consumes: Task 1 codec, `premoveTreeHash`, `premoveTreeCheck`; Task 2 `PremoveTreeRequestSchema`.
- Produces:
  - `games.premoveTree`: bytea, not null, default empty. Use `bytea` from `drizzle-orm/pg-core` if 0.45 exports it, else `customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })`.
  - `checkTreeYielding(fen: string, tree: readonly PremoveNode[], known: readonly PremoveNode[], slice = 256): Promise<TreeCheck>` in `domain/premoves.ts` — drives `premoveTreeCheck`, awaiting `setImmediate` every `slice` yields.
  - `setPremoveTree(deps: Deps, input: { gameId: string; userId: number; baseHash: string; tree: string; expectedPly: number }): Promise<GameDto>`
  - `GameDto.premoveTree` = base64url of the stored bytes for the owner (player not to move, game active), `''` otherwise.

- [ ] **Step 1: Write the migration.** Change `schema.ts` (add `premoveTree`; keep `premoves` with the comment "Unused since conditional premoves; dropped in a later release."), run `pnpm --filter @group-chess/server db:generate --name conditional_premoves`, then append to the generated SQL: `UPDATE "games" SET "premoves" = '{}'::text[] WHERE "premoves" <> '{}'::text[];`. The SQL must not drop `premoves`.
- [ ] **Step 2: Write the failing tests** (`api-premoves.test.ts`, same `world()` setup: Alice is White and to move, so Bob owns the tree; its branches are White moves and its replies Black moves, e.g. `[{ move:'e2e4', reply:'e7e5', children:[] }]`; helpers `enc = encodePremoveTree`, `hash = (t) => premoveTreeHash(encodePremoveBytes(t))`). Error *details* never reach the HTTP body (`app.onError` sends code and message only), so the API tests assert codes and the domain tests assert `details`:
  - `saves, replaces and clears the tree without bumping the version`: PUT with `baseHash = hash([])` saves; stored bytes decode to the tree; `version` unchanged; a second PUT with the first tree's hash replaces; a PUT with `tree: ''` clears.
  - `refuses the player to move, a stale ply, a stale fingerprint, a malformed tree and an illegal move`: response codes `not_your_turn`, `stale_state`, `stale_state`, `validation`, `illegal_move`.
  - `reports why it refused` (domain level, `premoves.test.ts`, calling `setPremoveTree` and catching `DomainError`): stale ply → `details.plyCount`; stale fingerprint → `details.reason === 'premoves_changed'`; an illegal reply `[{ move:'e2e4', reply:'e7e4', children:[] }]` → `details.path` equals `['e2e4','e7e4']`.
  - `checks only nodes not already stored`: write bytes for a tree with an illegal pair straight into `premoveTree`; a PUT whose `baseHash` matches those bytes and whose tree is the same plus one legal new root branch is accepted (the stored pair is not checked again).
  - `saves and edits a tree of 8,990 pairs, near the size limit`: build an 8,990-pair tree (encoded text within `PREMOVE_TREE_MAX_CHARS`) from the initial position (generate with chess.js, branchy at depth 0–2, long lines below); PUT it from empty, then PUT it again with one more pair; both 200; request bodies under 64 KB.
  - `refuses spectators and finished games`, `pushes an edit to the owner's streams only and publishes nothing for a no-op`, `gives a reconnecting device the current tree` — port the existing three tests to `premoveTree`.
  - `shows the tree to its owner only` (`premoves.test.ts`): Bob sees the base64url, Alice, Carol and anonymous see `''`; `resign` empties `premoveTree`.
- [ ] **Step 3: Run** `pnpm --filter @group-chess/server test -- api-premoves premoves` — Expected: FAIL.
- [ ] **Step 4: Implement** `setPremoveTree`: decode `tree` (format error → `DomainError('validation', …)`); read the game unlocked (by public id); if it is not active, the caller is not a player, or it is the caller's turn, or `plyCount !== expectedPly`, or the stored tree's fingerprint ≠ `baseHash`, skip the check and let the transaction report it; otherwise `checkTreeYielding(game.fen, tree, storedTree)` and throw `illegal_move` `{ path }` on failure. Then the transaction in the existing order (`lockActiveGame`, `not_your_turn`, ply, fingerprint of the locked row's tree), no-op when bytes are equal, else update `premoveTree` and publish to the owner. Route: `api.put('/games/:id/premoves', validate('json', PremoveTreeRequestSchema), …)`.
- [ ] **Step 5: Run** the same tests — Expected: PASS. Also `pnpm --filter @group-chess/server test` (old firing tests in `premoves.test.ts` still pass: firing still reads `premoves` until Task 4).
- [ ] **Step 6: Commit** `git commit -m "Server: store premove trees and save them by fingerprint"`

### Task 4: Firing loop and moves with a tree

**Files:**
- Modify: `apps/server/src/domain/games.ts`, `apps/server/src/api/routes/games.ts` (passes `premoveTree`), `apps/server/test/e2e/harness.ts` (expose `premoveTree` instead of `premoves`)
- Test: `apps/server/test/integration/premoves.test.ts` (firing blocks rewritten), `apps/server/test/integration/engine-move-flow.test.ts`

**Interfaces:**
- Consumes: `branchFor`, codec, `checkTreeYielding` (Task 3).
- Produces: `PlayMoveInput` gains `premoveTree: string` (default `''`); `CommitInput` loses `firePremoves`; `commitMove` runs the spec's loop (spec, API → Firing) and never reads `premoves`.

- [ ] **Step 1: Write the failing tests** (`premoves.test.ts`; helper `storeTree(id, tree)` writes `premoveTree` bytes; `move(…, tree?)` passes `premoveTree: encodePremoveTree(tree ?? [])`):
  - `plays the matching reply and keeps its subtree`: Bob's tree `[{ e2e4→e7e5, children:[{ g1f3→b8c6 }] }]`; Alice plays e2e4 → moves `['e4','e5']`, second `clientMoveId` `premove:<publicId>:2`, stored tree decodes to the g1f3 subtree, jobs = card + Alice's turn DM only.
  - `clears a missed tree and flags the owner's turn DM`: Alice plays d2d4 → tree empty, Bob's `send_dm` payload has `premovesCancelledAtPly: 1`.
  - `sends no flag when the line runs out`: reply with no children fires → tree empty, Alice's DM has no `premovesCancelledAtPly`.
  - `stores the mover's tree with their move`: Alice plays e2e4 with tree `[{ e7e5→g1f3 }]` and Bob has none → stored tree is Alice's, Bob's turn DM sent.
  - `plays alternating trees until one misses`: Bob's tree `e2e4→e7e5 { g1f3→b8c6 }`, Alice moves e2e4 with tree `[{ e7e5→g1f3, children:[{ b8c6→f1b5, children:[{ a7a6→b5a4 }] }] }]` → moves `e4 e5 Nf3 Nc6 Bb5`, plies 2–5 have `premove:` client ids, stored tree is Alice's `a7a6→b5a4` subtree, one `send_dm` (to Bob) and one card job.
  - `finishes the game when a fired reply mates` (Scholar's mate line) and the tree is cleared.
  - `fires a promoting reply` from a position with a pawn on the 7th.
  - `refuses a move whose tree is illegal, and plays nothing`: `illegal_move` with `path`; `plyCount` unchanged.
  - `returns the current state for a retried move with a tree`: same `clientMoveId` twice → second returns current DTO, stored tree unchanged by the retry.
  - `cancels a bot game tree with no send_dm job` (port the existing test).
  - `engine-move-flow.test.ts`: the human's tree reply fires after the engine's move; the engine job reports no stall and the next `engine_move` is enqueued.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/server test -- premoves engine-move-flow` — Expected: FAIL.
- [ ] **Step 3: Implement.** `playMove`: before the transaction, when `premoveTree !== ''`, decode it (format error → `validation`), read the game unlocked; if its `plyCount === expectedPly` and the move is legal there (`applyMove`), `checkTreeYielding(fenAfter, tree, [])` and throw `illegal_move` `{ path }` on failure. Inside the transaction keep today's order (idempotency check first, then ply, then turn). `commitMove`: write the loop exactly as in the spec, as a loop, with every fired move a full commit (move row, waiting DM, clock, draw-offer lapse) and the turn DM / card / engine enqueue only after the loop stops; `premovesCancelledAtPly` is the ply of the opponent move that missed.
- [ ] **Step 4: Run** the same tests, then `pnpm --filter @group-chess/server test` — Expected: PASS (delete the old chain-firing tests that no longer apply: "keeps a leftover premove…", "cancels when the opponent captured the piece…", en passant / castling chain tests are replaced by the tree tests above).
- [ ] **Step 5: Commit** `git commit -m "Server: fire conditional premoves in a loop and accept a tree with a move"`

### Task 5: Draft edits (pure)

**Files:**
- Create: `apps/miniapp/src/state/premoveDraft.ts`
- Test: `apps/miniapp/test/premoveDraft.test.ts`

**Interfaces:**
- Consumes: `DraftNode`, `countPremovePairs` (Task 1).
- Produces:
  - `type Path = readonly string[]` — alternating opponent move, reply, …, from the tree's root position
  - `fenAt(rootFen: string, path: Path): string`
  - `nodeAt(tree: readonly DraftNode[], path: Path): { level: readonly DraftNode[]; node: DraftNode | null }` — `level` is the list the path's last opponent move lives in (or the list at the path's end for an even path)
  - `type PlayResult = { tree: DraftNode[]; path: string[]; kind: 'navigate' | 'add' | 'reply' | 'replace'; replaced?: { old: string; dropped: number } }`
  - `playAt(tree: readonly DraftNode[], path: Path, uci: string): PlayResult` — immutable; even path: existing opponent move → `navigate`, else `add` (`reply: null`); odd path: same reply → `navigate`, no reply → `reply`, different reply → `replace` (children dropped; `dropped` = moves removed)
  - `removeAt(tree, path): { tree: DraftNode[]; path: string[]; removedMoves: number }` — removes the path's last move and everything after it; returns the parent path; `removedMoves` counts the moves after it (for an opponent move: its reply plus every move under it; for a reply: every move under it; 0 for a lone move)
  - `extendLine(tree, path): string[]` — follows the first branch / reply to the end
  - `isPrefix(a: Path, b: Path): boolean`
  - `moveLabel(fen: string, uci: string): string` — `4.Ng5` / `3…Nf6` (SAN via chess.js, number from the FEN)

- [ ] **Step 1: Write the failing tests** using the mockup's line (root fen after `1.e4 e5 2.Nf3 Nc6 3.Bc4`): add `g8f6` → `kind 'add'`, path `['g8f6']`; reply `f3g5` → `'reply'`; back to root and add `f8c5` then `c2c3` → two root branches in insertion order; replace `f3g5` with `b1c3` under `g8f6` when it had `d7d5 e4d5` under it → `'replace'`, `replaced: { old: 'f3g5', dropped: 2 }`, children empty; playing existing `g8f6` at root → `'navigate'`, tree unchanged (same reference not required, deep-equal); with `g8f6→f3g5 { d7d5→e4d5 }` and `f8c5→c2c3`, `removeAt(tree, ['g8f6'])` → only the `f8c5` branch left, path `[]`, `removedMoves: 3`; `removeAt(tree, ['g8f6','f3g5'])` → `g8f6` kept with `reply: null`, `removedMoves: 2`; `extendLine` from `['g8f6']` reaches the end of the first line; `moveLabel(rootFen, 'g8f6') === '3…Nf6'`; inputs are not mutated (`Object.freeze` the input tree).
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- premoveDraft` — Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block (structural sharing is fine; never mutate inputs).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Mini App: pure draft edits for premove trees"`

### Task 6: Lines layout and panel

**Files:**
- Create: `apps/miniapp/src/state/premoveLines.ts`, `apps/miniapp/src/ui/game/LinesPanel.tsx`
- Modify: `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/premoveLines.test.ts`, `apps/miniapp/test/linesPanel.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`Path`, `fenAt`).
- Produces:
  - `type LineToken = { path: string[]; san: string; number: string | null; mine: boolean }` — `number` is `'7.'` before White's moves and `'5…'` before a Black move that starts a block
  - `type LineBlock = { depth: number; split: boolean; tokens: LineToken[] }` — `depth` capped at 3; `split` true for blocks that start at an alternative
  - `linesModel(tree: readonly DraftNode[], rootFen: string, owner: Colour): LineBlock[]` — one block per line; a line runs on while a reply has exactly one child branch; where a reply has 2+ children, each child starts a block at `depth + 1` with `split: true`; root branches are blocks at depth 0, `split: false`
  - `<LinesPanel tree rootFen owner root={{ label: string; caption: string }} selected={Path} onSelect={(path) => void} onRemove={() => void} />` — GameView passes `root` as `{ label: '3.Bc4', caption: t('app.game.lines_your_move') }` while a move waits, else `{ label: t('app.game.lines_now'), caption: t('app.game.lines_now_caption') }` (copy in Task 10) — root chip (`data-path=""`), blocks, the selected token filled with a `✕` button (`data-action="premove-remove"`) right after it inside a `nowrap` unit
- [ ] **Step 1: Write the failing tests**: the 22-move chain from the spec's screenshot (`3…Nb4 4.d3 Nxd3+ 5.Bxd3 d6 …`) is **one** block; adding a second child after `5.Bxd3` gives 3 blocks (`3…Nb4 … 5.Bxd3`, `5…d6 …` split depth 1, `5…Qe7 6.O-O` split depth 1); depth never exceeds 3 on a tree branching at every level for 6 levels; numbers: first token `'3…'`, White moves `'4.'`, Black continuation tokens `null`. Panel: renders the ✕ only beside the selected token; clicking a token calls `onSelect` with its path; the panel element has no `overscroll-behavior` style (assert computed style or the class's CSS absent of `contain`).
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- premoveLines linesPanel` — Expected: FAIL.
- [ ] **Step 3: Implement** the model and the panel; CSS per spec §The game screen item 5 (opponent moves `--hint`, own `--pm` bold, selected `--pm` filled, split rule `--pm-sq`, `max-height: 34vh; overflow-y: auto`, no `overscroll-behavior`), reusing `.move-list button.premove-remove` look for ✕.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Mini App: Lines panel for premove trees"`

### Task 7: Timeline model

**Files:**
- Create: `apps/miniapp/src/state/premoveTimeline.ts`
- Test: `apps/miniapp/test/premoveTimeline.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - `type Timeline = { plies: number; rootIndex: number; line: string[]; end: number; at: number }` — `rootIndex = plies + (waiting ? 1 : 0)`, `end = rootIndex + line.length`
  - `buildTimeline(input: { plies: number; waiting: boolean; tree: readonly DraftNode[]; selected: Path; trail: Path; earlierPly: number | null }): Timeline` — `line` = `trail` if `selected` is a prefix of it (truncated to its valid part), else `selected`, then extended with `extendLine`; `at` = `earlierPly ?? rootIndex + selected.length`
  - `type TimelineTarget = { earlierPly: number | null; selected: string[] }`
  - `timelineTarget(timeline: Timeline, index: number): TimelineTarget` — clamps; `index < rootIndex` → `{ earlierPly: index, selected: [] }`; else `{ earlierPly: null, selected: line.slice(0, index - rootIndex) }`
- [ ] **Step 1: Write the failing tests**: real plies 4 + waiting move + line of 4 → `end 9`, `at 9` at the line's end; index 5 → selected = root (`[]`), earlierPly null; index 4 → `earlierPly 4` (before the waiting move); index 2 → `earlierPly 2`; going back to index 6 then forward to 9 keeps a non-first branch (trail preserved); without a waiting move, index 4 is the root.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- premoveTimeline` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Mini App: timeline model for real moves and premove lines"`

### Task 8: Store

**Files:**
- Modify: `apps/miniapp/src/state/game.ts`
- Test: `apps/miniapp/test/gameStore.test.ts`, `apps/miniapp/test/support/gameFixtures.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 7.
- Produces (on `GameStore`, **added beside** the old premove signals, which keep working until Task 10 switches GameView over and Task 12 deletes them):
  - `serverTree: ReadonlySignal<PremoveNode[]>` (decoded `dto.premoveTree`)
  - `waiting: Signal<{ uci: string; san: string } | null>` — the player's move waiting for Confirm (set by GameView from the move machine)
  - `draftTree: Signal<DraftNode[] | null>` — `null` means "no edits; show `serverTree`"
  - `tree: ReadonlySignal<DraftNode[]>` = `draftTree ?? serverTree`
  - `selected: Signal<string[]>`, `trail: Signal<string[]>`, `viewingPly` (kept; now "earlier ply")
  - `building: ReadonlySignal<boolean>` — active game, viewer is a player, not `moveBusy` sending/retrying, and (opponent to move, or `waiting !== null`)
  - `rootFen: ReadonlySignal<string>` — `dto.fen`, or the position after `waiting`
  - `draftDirty: ReadonlySignal<boolean>` — `waiting !== null` or `draftTree` encodes differently from `serverTree`
  - `timeline: ReadonlySignal<Timeline>`; `viewTimeline(index: number): boolean`
  - `buildView: ReadonlySignal<{ position: Position; turn: Colour; dests: Map<string, string[]>; canMove: boolean }>` — while `building`, at the latest position: the position at `selected` (last move highlighted), its side to move, full `legalDests`; at `viewingPly`: that position, view-only, except the position before `waiting`, which is movable for the player. Task 10 makes `boardView`, `boardTurn`, `dests` and `canMove` read it.
  - `resetDraft(): void` — clears `draftTree`, `waiting`, `selected`, `trail`
  - `diffNotices(prev, next)` reworked: walk `next.moves` after `prev.plyCount` against `decodePremoveTree(prev.premoveTree)`: count matched opponent-move+reply pairs → `premove_played` if ≥ 1; `premoves_cancelled` when the walk stops on an opponent move absent from a non-empty remaining tree while `next.status === 'active'`
  - `premoveDraftChanged: ReadonlySignal<boolean>` — `draftTree` encodes differently from `serverTree` (a waiting move alone does not count)
  - `apply(next)` treats a changed `premoveTree` as new (like `premoves` today); a new ply or status calls `resetDraft()`
  - `diffNotices(prev, next, options: { discardedDraft?: boolean } = {})` adds the new `Notice` `'premove_draft_discarded'` when `options.discardedDraft` and the ply or status changed. GameView's `applyState` reads `store.premoveDraftChanged.value` before `store.apply(next)` and passes it.
- [ ] **Step 1: Write the failing tests** (gameStore): `tree` falls back to `serverTree`; `building` true on the opponent's turn and false while `moveBusy`; dests at the root are the opponent's legal moves; after selecting an odd path dests are the owner's; `viewTimeline` to the position before `waiting` makes `canMove` true and to an earlier ply false; `diffNotices` → played (1 pair), played ×2 then cancelled, ran-out (no cancel); `apply` with a new ply clears the draft; `diffNotices(prev, next, { discardedDraft: true })` across a new ply includes `'premove_draft_discarded'`, and at the same ply does not.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- gameStore` — Expected: FAIL.
- [ ] **Step 3: Implement** the new signals; leave the old ones and GameView untouched.
- [ ] **Step 4: Run** `pnpm --filter @group-chess/miniapp test` — Expected: PASS (old premove tests still pass).
- [ ] **Step 5: Commit** `git commit -m "Mini App: store for premove drafts, selection and timeline"`

### Task 9: Move strip and slider

**Files:**
- Modify: `apps/miniapp/src/ui/game/MoveList.tsx`, the replay controls in `apps/miniapp/src/ui/game/GameView.tsx`, `apps/miniapp/src/styles.css`
- Test: `apps/miniapp/test/premoveUi.test.tsx` (rewrite)

**Interfaces:**
- Consumes: store (Task 8).
- Produces: `MoveList` props `{ store: GameStore; locked?: boolean; onRemove?: () => void }`. Buttons: real moves `data-ply`, waiting move `data-waiting`, premove line `data-line="<index>"` (index in `timeline.line`), each `aria-current` per `timeline.at`; the waiting move class `waiting` (accent outline), opponent line moves class `line-opponent`, own `premove-chip`; ✕ `data-action="premove-remove"` after the current line move only when `viewingPly === null`. Slider and ◀ ▶ (`data-action="prev"`/`"next"`) drive `store.viewTimeline`.
- [ ] **Step 1: Write the failing tests**: strip text for real moves + waiting + line; tapping a line move selects it; ✕ shown once, beside the current line move, never on real or waiting moves; slider `max` = `timeline.end`, `value` = `timeline.at`, class `premove` past the real position; ◀ from the root goes before the waiting move, then into history; the strip scrolls so the ✕ is visible (`scrollLeft` covers the ✕'s right edge).
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- premoveUi` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @group-chess/miniapp test -- premoveUi` — Expected: PASS. The old premove cases in `game.test.tsx` (strip chips with `data-premove`) now fail by design; Task 10 replaces them, so note them in the commit message rather than patching them.
- [ ] **Step 5: Commit** `git commit -m "Mini App: move strip and slider follow the premove line"`

### Task 10: Building, confirming and saving

**Files:**
- Modify: `apps/miniapp/src/ui/game/GameView.tsx`, `apps/miniapp/src/state/moveMachine.ts`, `apps/miniapp/src/ui/dialog.tsx`, `packages/shared/src/i18n/en.ts`, `apps/miniapp/src/board/adapter.ts` (only if `setMovable` needs both colours: `colour: 'both'`)
- Test: `apps/miniapp/test/game.test.tsx`, `apps/miniapp/test/moveMachine.test.ts`, `apps/miniapp/test/dialog.test.tsx`

**Interfaces:**
- Consumes: Tasks 5–9; `encodePremoveTree`, `premoveTreeHash`, `encodePremoveBytes`, `PREMOVE_TREE_MAX_CHARS`.
- Produces:
  - `PendingMove` gains `premoveTree: string`; event `{ type: 'confirm'; premoveTree: string }`; new event `{ type: 'replace'; uci: string }` valid in `pendingConfirm` (new `clientMoveId`, same `expectedPly`, no effects)
  - `confirmDialog(message, { confirmLabel?, danger?, title?, cancelLabel? })` — `cancelLabel` renders a native `default` button with that text (in-page sheet too)
  - Copy keys (exact text):
    - `app.game.confirm_move_premove`: `Confirm move + 1 premove`; `app.game.confirm_move_premoves`: `Confirm move + {n} premoves`; `app.game.confirm_premoves`: `Confirm premoves`
    - `app.game.pill_draft`: `Draft`; `app.game.pill_your_move`: `Your move`; `app.game.pill_saved_one`: `1 premove saved`; `app.game.pill_saved`: `{n} premoves saved`; `app.game.pill_opponent`: `{name} to move`
    - `app.game.hint_play`: `Play your move`; `app.game.hint_opponent`: `Play a move {name} might make`; `app.game.hint_reply`: `Your reply to {move}`; `app.game.hint_branch`: `Play another of {name}’s moves to branch`; `app.game.hint_replace`: `Play another move to replace {move}`; `app.game.hint_before`: `Before your {move} · play another move to replace it`; `app.game.hint_earlier`: `An earlier move · tap the board to go back`
    - `app.game.premove_replace_confirm`: `Replace {old} with {new}?`; `app.game.premove_replace_after_one`: `The move after {move} will be removed too.`; `app.game.premove_replace_after`: `The {n} moves after {move} will be removed too.`; `app.game.premove_replace_waiting_one`: `Your premove after {move} will be removed too.`; `app.game.premove_replace_waiting`: `Your {n} premoves after {move} will be removed too.`; `app.game.premove_replace`: `Replace`
    - `app.game.premove_remove_confirm`: `Remove {move}?`; `app.game.premove_remove_confirm_next`: `Remove {move} and the move after it?`; `app.game.premove_remove_confirm_rest`: `Remove {move} and the {n} moves after it?`
    - `app.game.premove_removed`: `Removed {move}`; `app.game.premove_removed_next`: `Removed {move} and 1 move after it`; `app.game.premove_removed_rest`: `Removed {move} and {n} moves after it`
    - `app.game.premove_own_first`: `Play your own move first. Then you can play the moves {name} might make.`; `app.game.premove_draft_discarded`: `{name} moved. Your unconfirmed premoves were discarded.`; `app.game.premove_too_big`: `This premove tree is too big to save. Remove some lines first.`
    - `app.game.lines_now`: `Now`; `app.game.lines_now_caption`: `current position`; `app.game.lines_your_move`: `your move`
    - `app.settings.move_confirmations_help`: `Ask before a move is sent. With "Only against people", moves against the bot send on drop. Premoves are confirmed with the move.`
    - Remove `app.game.premove_current`, `premove_step`, `premove_prev`, `premove_next` if present.
- [ ] **Step 1: Write the failing tests** (`game.test.tsx`, existing harness with a fake client and fake `tg`):
  - confirmations on, own turn: drop e2e4 → board shows it, `waiting` set; drop e7e5 (opponent) then g1f3 → MainButton text `Confirm move + 1 premove`; confirm → exactly one `POST /moves` whose body has `premoveTree === encodePremoveTree(tree)`; no `PUT`.
  - confirmations on, opponent's turn: add a pair → MainButton `Confirm premoves`; confirm → one `PUT` with `baseHash` of the server tree; Cancel → draft gone, no request.
  - confirmations off: drop sends the move at once; each completed pair → one `PUT` (serial; a second edit during a save is sent after it with the confirmed hash); an unanswered opponent move sends nothing.
  - replace: playing a different reply opens `confirmDialog` with `Replace 4.Ng5 with 4.Nc3?\nThe 2 moves after Ng5 will be removed too.`; while open the board position shows Nc3; answering cancel restores the previous board and tree; confirm keeps it.
  - replace the waiting move from the position before it, with premoves → asks with `Your 1 premove after Bc4 will be removed too.`; without premoves → no popup.
  - remove: ✕ asks `Remove 3…Nf6 and the 4 moves after it?`; confirm → toast `Removed 3…Nf6 and 4 moves after it`.
  - `discards an open draft when the opponent moves`: a state with a new ply → draft and waiting move gone, toast `Dana moved. Your unconfirmed premoves were discarded.` (only when the draft had premove changes).
  - `keeps an oversize change on screen`: with `PREMOVE_TREE_MAX_CHARS` exceeded (stub the constant or build a large tree) no request is sent and the toast `This premove tree is too big to save. Remove some lines first.` shows; a 413 from `PUT` shows the same toast and does not reload.
  - touching an opponent piece on the own turn before moving → toast `Play your own move first. Then you can play the moves Dana might make.`
  - a promotion inside the tree, for the opponent and for the player, opens the picker and stores the chosen piece in the node's UCI.
  - a `PUT` refused with `stale_state` at an unchanged ply reloads and shows `Premoves changed on another device`.
  - the status line shows the pill and hint for each case: `Draft` + `Your reply to 3…Nf6`; `2 premoves saved`; `Dana to move` + `Play a move Dana might make`; `Before your 3.Bc4 · play another move to replace it`.
  - minimising (`tg` deactivated event) keeps the waiting move and the draft.
  - `moveMachine.test.ts`: `confirm` copies `premoveTree` into the sent move; `replace` swaps the pending move with a new `clientMoveId`.
  - `dialog.test.tsx`: `cancelLabel` produces a `default` native button with that text and resolves `false` for it.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- game moveMachine dialog` — Expected: FAIL.
- [ ] **Step 3: Implement.** Point `boardView`, `boardTurn`, `dests` and `canMove` at `store.buildView` while `building`, and delete the old premove signals' uses from GameView (Task 12 deletes the signals). Board: in building mode `setMovable({ colour: side to move at the shown position, dests: store.dests })` and `turnColour` likewise; highlights via `setHighlights` for the selected move. Saves: confirmations on → only on Confirm; off → per completed change, through one serial save loop (today's `editPremoves` pattern) keyed by fingerprints. Before any request, if `encodePremoveTree(tree).length > PREMOVE_TREE_MAX_CHARS`, don't send. Remove `tg.onDeactivated(() => dispatch({ type: 'cancel' }))`. The replace preview is a temporary `draftTree`/`waiting` change restored on Cancel and never enters the save loop until confirmed.
- [ ] **Step 4: Run** `pnpm --filter @group-chess/miniapp test` — Expected: PASS (whole Mini App suite, including Tasks 8–9).
- [ ] **Step 5: Commit** `git commit -m "Mini App: build, confirm and save conditional premoves"`

### Task 11: Ask before leaving with an unconfirmed draft

**Files:**
- Modify: `apps/miniapp/src/router.ts`, `apps/miniapp/src/boot.ts`, `apps/miniapp/src/ui/game/GameView.tsx`, `packages/shared/src/i18n/en.ts`
- Test: `apps/miniapp/test/router.test.ts` (create if absent), `apps/miniapp/test/game.test.tsx`

**Interfaces:**
- Produces:
  - `Router.leaveGuard: (() => Promise<boolean>) | null` (public field); `Router.back()` stays sync; new `async Router.leave(action: () => void): Promise<void>` runs `action` only when there is no guard or the guard resolves true; the BackButton handler and `select(tab)` go through `leave`; `boot.ts`'s Settings button calls `router.select('settings')` unchanged (it is guarded inside `select`)
  - Copy: `app.game.leave_title`: `Leave this game?`; `app.game.leave_premoves`: `Your premoves haven't been confirmed and will be lost.`; `app.game.leave_move_premoves`: `Your move and premoves haven't been sent and will be lost.`; `app.game.leave_move`: `Your move hasn't been sent and will be lost.`; `app.game.stay`: `Stay`; `app.game.leave`: `Leave`
- [ ] **Step 1: Write the failing tests**: router — with a guard resolving false, BackButton click and `select('settings')` leave the stack unchanged; resolving true pops / switches; no guard → unchanged behaviour. GameView — while `draftDirty`, the guard asks `confirmDialog(t('app.game.leave_move_premoves'), { title: t('app.game.leave_title'), confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true })` (message chosen by what the draft holds), and `tg.setClosingConfirmation(true)`; when clean, no guard and closing confirmation off; with confirmations off nothing ever asks.
- [ ] **Step 2: Run** `pnpm --filter @group-chess/miniapp test -- router game` — Expected: FAIL.
- [ ] **Step 3: Implement.** GameView sets `router.leaveGuard` and `tg.setClosingConfirmation` from `store.draftDirty` in an effect, and clears both on unmount.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Mini App: ask before leaving a game with an unconfirmed draft"`

### Task 12: Remove the blind chain and update docs

**Files:**
- Delete: `packages/shared/src/chess/premove.ts`, `packages/shared/test/chess/premove.test.ts`, `apps/miniapp/src/state/premoves.ts`, `apps/miniapp/test/premoves.test.ts`
- Modify: `apps/miniapp/src/state/game.ts` (delete `optimisticPremoves`, `premoveStep`, `premoves`, `premoveOpen`, `premoveMode`, `shownStep`, `atChainEnd`, `premoveSquares`, `premoveLabels`, `viewPremove`), `packages/shared/src/index.ts`, `packages/shared/src/protocol/requests.ts` (drop `PremovesRequestSchema`), `packages/shared/src/protocol/dto.ts` (drop `premoves`), their tests, `apps/server/src/domain/gameDto.ts`, any remaining `premoves` reads in server and Mini App (keep only the unused `schema.ts` column), `docs/PRD.md` §7.4, `docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` §2, `docs/superpowers/specs/2026-09-24-premoves-design.md` (status: superseded by the conditional premoves spec), `docs/superpowers/specs/2026-09-24-move-confirmations-design.md` (note: minimise and leave rules superseded)
- [ ] **Step 1: Verify the leftovers**: `grep -rn "premoves\b\|PremovesRequest\|imaginedBoard\|premoveTargets\|checkPremoveChain\|premoveLabel" packages apps --include=*.ts --include=*.tsx` lists only `schema.ts`, the migration SQL, `dm.ts`'s `premovesCancelled*` fields and `dmText.ts`.
- [ ] **Step 2: Run the whole suite**: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "Remove the blind premove chain; docs point to conditional premoves"`

### Task 13: End-to-end

**Files:**
- Modify: `apps/miniapp/e2e/premove.spec.ts` (rewrite), `apps/miniapp/e2e/support.ts` (`harnessGame(...).premoveTree`), `apps/miniapp/e2e/spectator.spec.ts` (field rename)
- [ ] **Step 1: Write the specs**:
  - `confirms a move with two branches in one request`: Bob (confirmations `always`) on his turn drags his move, then White's e2e4-style reply and his answer, steps back with `[data-action="prev"]` to the root and adds a second branch; MainButton text `Confirm move + 2 premoves`; one `POST /moves` (route spy) and `harnessGame().premoveTree` decodes to both branches.
  - `fires a premove on the bot's reply` (bot game, confirmations `never`): each pair saves on its own; the bot's matching move is answered at once.
  - `shows the toast when the opponent misses the tree`.
  - `asks before Remove and Replace, and Cancel restores the board` (answer popups via `window.__tg.answerPopup`).
  - `refuses a stale edit from a second page as the same player` with the toast `Premoves changed on another device`.
  - `asks before leaving with an unconfirmed draft` (BackButton → popup → Stay keeps the screen).
- [ ] **Step 2: Run** `pnpm e2e -- premove` — Expected: PASS.
- [ ] **Step 3: Run** `pnpm build && pnpm check:budget` — Expected: within the bundle budget.
- [ ] **Step 4: Commit** `git commit -m "E2E: conditional premoves"`
