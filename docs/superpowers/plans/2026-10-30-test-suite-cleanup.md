# Test Suite Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every test fail for the reason its name gives, then shrink the suite's volume and per-test setup through deletions, layer moves and a small set of scenario builders.

**Architecture:** Work in the spec's six phases, in order. Phases 1–2 fix trust: the harness's fidelity, tests that can't fail, and the gaps. Phase 3 deletes duplicates and moves tests to the right layer. Phases 4–5 add builders in `apps/server/test/helpers/` and `apps/miniapp/test/support/` and rewrite tests onto them. Phase 6 updates the docs. No product behaviour changes.

**Tech Stack:** TypeScript, vitest 5 (projects: shared, server, miniapp), happy-dom, Preact 11, Playwright, PostgreSQL via drizzle.

**Spec:** `docs/superpowers/specs/2026-10-30-test-suite-cleanup-design.md`. Item ids (A4, C, D…) refer to its appendix, which gives the file and line of every finding. Read the spec's appendix entry for each item before acting on it.

## Global Constraints

- Branch: `claude/friendly-lovelace-c2r30f`. Push after each task; open a pull request only if the owner asks.
- **The suite is green after every commit.** Before each commit, run the full check:

  ```bash
  export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test
  pnpm test && pnpm typecheck && pnpm lint && pnpm format:check
  ```

  Start Postgres first with `PGBIN=/usr/lib/postgresql/16/bin scripts/local-postgres.sh start` (this container has PG 16).
- **Check integration tests actually ran.** Without `TEST_DATABASE_URL` the integration tests are skipped silently. The vitest output must show the server project running `test/integration/**` files. The baseline is 126 files and 1,510 tests.
- **Run e2e after Tasks 1, 2 and 12:**

  ```bash
  createdb -h 127.0.0.1 -p 54329 -U postgres group_chess_e2e
  pnpm build
  TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_e2e PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 pnpm e2e
  ```

  The `createdb` is needed only once. The fonts must exist (`pnpm fonts`).
- **Protected suites must not lose a case:** arbiter, Glicko-2, PGN, `initData`, the integration race and idempotency tests, and `moveMachine`. Duplicates inside them may be merged. Every rename or merge of an `it(` title in those files is named in the commit message.
- **Engine tests:** no test may assert a specific engine move, evaluation, mate score or strength. Engine tests use `fakeEngine` only.
- **`it.each`:** only where cases differ by data alone, and the title template still reads as a behaviour.
- **Builders:** builders return plain rows and take explicit overrides. A builder never reads module-level state, never registers hooks, and never hides a test's position, roles or preferences.
- **Product code (`src`):** changes only to remove exports that exist only for tests (D), or to fix a real bug a corrected test exposes. A bug fix goes in its own commit with its own test, and is reported to the owner.
- **Mutation check:** this is how a fixed test (Phase 2) or a surviving copy of a deleted duplicate (Phase 3) is proven able to fail.
  1. Break the behaviour in `src` temporarily.
  2. Run that test and see it go red.
  3. Revert the change (`git checkout -- <file>`).
  4. Record the check in one line of the commit message, for example `A4: removed deadline update in playMove → red`.
- **Commit trailers:** commit messages end with the session's attribution lines, and contain no model identifiers.

## Review Focus

1. **Lock-sensitive tests after the builder rewrite.** The race tests must behave exactly as before. Task 10 runs each race and idempotency test 10 times after its setup line changes.
2. **The fake's minimum version for each method is the SDK's, not the app's.** If the fake copied the app's table (`src/tg/webapp.ts:19-30`), an app bug in that table would be invisible again. For example, the SDK gates `SettingsButton` at 6.10 and the app at 7.0. Task 1 adds a test at version 6.10 that asserts the app does not show the settings button, and the unsupported check stays quiet.
3. **A "duplicate" that is really the only test of a branch.** Tasks 7 and 8 run the mutation check on the surviving copy before each deletion. If the survivor stays green, the deletion is cancelled.
4. **`act()` around the first render changes what a test sees on its first assertion.** A test that meant to assert the state before an effect ran would now see the state after it. In Task 2, look for every test whose first assertion comes before any `flush`/`click`, and confirm it asserts the intended state.
5. **Integration tests skipped silently.** Every task's final verification step states the expected server file count, so a run without `TEST_DATABASE_URL` is caught.

---

## Phase 1: Harness fidelity

### Task 1: Fake Telegram client behaves like the real SDK; a global unsupported-call check

**Files:**
- Modify: `apps/miniapp/test/support/fakeWebApp.ts`
- Create: `apps/miniapp/test/support/setup.ts`
- Modify: `apps/miniapp/vitest.config.ts`
- Modify: `apps/miniapp/test/tg.test.ts`, `apps/miniapp/test/boot.test.ts`
- Modify: `apps/miniapp/e2e/fallbacks.spec.ts`, `apps/miniapp/e2e/support.ts`
- Modify: the tests that read `record.links` (`settings.test.tsx:197`, `supportCard.test.tsx:204`, `tg.test.ts:162`)

**Interfaces:**
- Produces:
  - `FakeWebAppRecord.unsupported: string[]`, holding method or object names called below their minimum version.
  - `FakeWebAppRecord.telegramLinks: string[]` (from `openTelegramLink`). `links` now holds only `openLink` URLs.
  - `allowUnsupported(...names: string[]): void`, exported from `support/setup.ts`.
  - The `writeAccess` option now means "what the user answers" and defaults to `false`. The method always exists.

**Reference:** the SDK reference is the copy of the real script in `@twa-dev/sdk@8.0.2`. Fetch it into a scratch directory:

```bash
npm pack @twa-dev/sdk@8.0.2
tar -xzf twa-dev-sdk-8.0.2.tgz
```

The file is `package/src/telegram-web-apps.js`. Don't commit it or add it as a dependency. What the SDK does below each minimum version (the line numbers are in that file):

| Method / object | SDK min | Below the minimum, the SDK… | Fake below the minimum |
|---|---|---|---|
| `HapticFeedback.*` | 6.1 | warns and returns | record `unsupported`, no-op |
| `setHeaderColor`, `setBackgroundColor` | 6.1 | warns and returns | record, no-op |
| `setBottomBarColor` | 7.10 | warns and returns | record, no-op |
| `enable`/`disableClosingConfirmation` | 6.2 | warns and returns | record, no-op |
| `enable`/`disableVerticalSwipes` | 7.7 | warns and returns | record, no-op |
| `SettingsButton.*` | 6.10 | warns, returns false | record, no-op |
| `SecondaryButton.*` | none in the SDK; old clients ignore the event | — | record if version < 7.10 (the client drops it, so the user sees nothing) |
| `openInvoice` | 6.1 | logs an error and throws `WebAppMethodUnsupported` | record, then throw `Error('WebAppMethodUnsupported')` |
| `showPopup` | 6.2 | logs an error and throws | record, then throw |
| `requestWriteAccess` | 6.9 | logs an error and throws | record, then throw |
| `downloadFile` | 8.0 | logs an error and throws | record, then throw |

The builder checks each row against the reference file before coding it. Wherever the reference disagrees with this table, the reference wins; note the difference in the commit message.

- [ ] **Step 1: Write the failing tests in `tg.test.ts`**

  These assert that the app's gating avoids the methods, not that the methods are absent.
  - Replace each "below X it does nothing" test: `skips haptics below 6.1…`, `answers null for write access below 6.9…`, `offers no popup below 6.2`, `offers no invoice below 6.1`, and the secondary-button, swipes and download cases.
  - Each one becomes a single test per feature, using `it.each` over `[feature, belowVersion, call]`, titled `'does not call $feature below its minimum version'`.
  - Each case installs the fake at `belowVersion` and calls the `Tg` method. It relies on the global check (Step 4) for the failure; the test body asserts only the `Tg` method's return value (`false`/`null`/`undefined`).
  - Add `'keeps the settings button hidden on 6.10, where the SDK has it but the app does not'` (Review Focus 2). It asserts `onSettingsButton` registers nothing at 6.10, and that `unsupported` is empty.
  - Keep `supports()`'s capability test (`tg.test.ts:27`) and delete its repeat at `:187`.
  - Delete `beforeEach(delete window.__tg)` (`:13-15`).

- [ ] **Step 2: Run them to see the gap**

  Run `pnpm vitest run apps/miniapp/test/tg.test.ts`.
  Expected: they pass, which is the fidelity bug. Now temporarily delete the `supports('haptics')` check in `src/tg/webapp.ts:235` and run again: still green. Restore the check. This is the baseline the fix must turn red.

- [ ] **Step 3: Rewrite the gated sections of `installFakeWebApp`**

  - Every method or object in the table exists on every version.
  - Below its minimum version, it pushes its name to `record.unsupported` and then follows the table: no-op, or throw.
  - Merge the three `atLeast('6.1')` blocks into one.
  - `openTelegramLink` pushes to `record.telegramLinks` and records `openTelegramLink:<url>` in `calls`.
  - Delete the unused `themeParams` and `platform` options.
  - The function must stay self-contained, because Playwright serialises its source.

- [ ] **Step 4: Create `support/setup.ts` with the global check**

  - An `afterEach` reads `window.__tg?.unsupported ?? []`, removes the names passed to `allowUnsupported` during that test, and throws `expect(...).toEqual([])` with the leftover names.
  - It also resets the allowed set.
  - Register the file in `vitest.config.ts` as `setupFiles: ['test/support/setup.ts']`.

- [ ] **Step 5: Prove the check bites**

  1. Delete the `supports('haptics')` check in `src/tg/webapp.ts:235` again.
  2. Run `pnpm vitest run apps/miniapp`. Expected: FAIL, naming `HapticFeedback` (in `tg.test` and in every screen test on an old version that triggers haptics).
  3. Restore the check.
  4. Repeat once for `supports('popup')` at `:278`.

  Record both checks in the commit message.

- [ ] **Step 6: Update the link assertions**

  - `settings.test.tsx:197` and `supportCard.test.tsx:204` assert on `telegramLinks` for t.me links and on `links` for web links.
  - `tg.test.ts:162` asserts that each method lands in its own list.

- [ ] **Step 7: Update `boot.test.ts:123-124`**

  Drop the "below version" negative assertions that the global check now covers. Keep the positive assertion of each fallback.

- [ ] **Step 8: Update `e2e/fallbacks.spec.ts`**

  - Replace the four negative reads (`secondaryButton === null`, etc. at `:16-19`) with one assertion: `await page.evaluate(() => window.__tg!.unsupported)` equals `[]`.
  - Keep the positive fallbacks, such as the in-page sheet appearing.
  - In `e2e/support.ts`, add the same `unsupported` assertion to the shared fixture's teardown, so every e2e spec checks it.

- [ ] **Step 9: Verify**

  Run the full check and e2e. Expected: all green, and `tg.test` has fewer tests than before.

- [ ] **Step 10: Commit**

  `git commit -m "Make the fake Telegram client behave like the SDK on old versions"`, with the mutation-check lines.

### Task 2: First render inside `act()`; remove the flush workarounds

**Files:**
- Modify: `apps/miniapp/test/support/render.tsx:72-80`
- Modify: `apps/miniapp/test/settings.test.tsx` (`:73`, `:143`, `:235`), and every test file that starts with a bare `await r.flush()` right after `renderApp`/`mount`

**Interfaces:**
- Produces: `renderApp(...)` returns with the first render's effects already run. Its signature is unchanged.

- [ ] **Step 1: Prove A3 is vacuous today**

  1. In `src/ui/screens/Settings.tsx`, make the delete confirm ignore a cancel: treat any answer as confirm.
  2. Run `pnpm vitest run apps/miniapp/test/settings.test.tsx -t "deletes my data"`. Expected: PASS, which is the bug.
  3. Revert.

- [ ] **Step 2: Wrap the first render**

  Wrap the `render(<AppProvider…>, root)` call in `act(() => …)`.

- [ ] **Step 3: Re-run A3 with the same mutation**

  Expected: FAIL. Revert the mutation, and the test passes.

- [ ] **Step 4: Delete the workarounds**

  Delete each bare `await r.flush()` that directly follows a mount, plus the "effect-timing quirk" comments, one file at a time. Run that file after each one. Keep a flush wherever removing it turns the file red, and add a one-line comment saying what it waits for.

- [ ] **Step 5: Review Focus 4**

  List every test whose first assertion comes before any `flush`/`click`/`act`:

  ```bash
  rg -n "renderApp|mount\(" apps/miniapp/test
  ```

  Read each hit. Confirm the assertion still names the state the title describes. Fix the test if not.

- [ ] **Step 6: Verify**

  Run the full check and e2e.

- [ ] **Step 7: Commit**

  `git commit -m "Render the first frame inside act() and drop the flush workarounds"`, with the A3 mutation line.

## Phase 2: Tests that can't fail, and the gaps

Each item follows the same cycle: mutate `src` and watch the test stay green, fix the test, mutate again and watch it go red, revert, then record the check in the commit message. The steps below give the fix and the mutation for each item.

### Task 3: Server tests that can't fail (A4–A7, A10, A11, A13, A14) and server names (E)

**Files:**
- Modify: `apps/server/test/integration/{games,telegram-handlers,engine-user,share-photo,challenges,engine-games,dm-messages}.test.ts`
- Modify: `apps/server/test/integration/migration-0011.test.ts` (it gains the engine-user check from A6)
- Modify: `apps/server/test/unit/board.test.ts`

- [ ] **Step 1: A4 (`games.test.ts:116`)**
  - Fix: insert with `{ deadlineInSeconds: 60 }`, then assert `secondsUntil('deadline_at') > 86_390`.
  - Mutation: skip the `deadlineAt` update in `playMove`.

- [ ] **Step 2: A5 (`telegram-handlers.test.ts:258`)**
  - Split it into `'sends the turn DM with both buttons'` and `'skips a player on move who declined DMs'`.
  - In the second test the decliner is the side to move.
  - Mutation: drop the `dmAllowed` check in `src/jobs/handlers/dm.ts`.

- [ ] **Step 3: A6 (`engine-user.test.ts:15`)**
  - Delete the "exists after migration, exactly once" and `firstName 'Stockfish'` tests.
  - Add `'creates exactly one engine user, named Stockfish'` to `migration-0011.test.ts`, which builds a fresh scratch database: after migrating, `select count(*) from users where is_engine` is 1, with `first_name = 'Stockfish'`.
  - Mutation: comment out the insert in migration 0002's SQL inside the scratch run.

- [ ] **Step 4: A7 (`share-photo.test.ts:224`)**
  - Assert that shares at plies 0, 1 and 2 produce 3 distinct `board_images` rows.
  - Rename `:252` to `'stops when the bot has left the chat'`, and add `'does not re-send once the share was sent'` with `messageId` set.
  - Mutation: ignore the ply when rendering.

- [ ] **Step 5: A10 (`challenges.test.ts:185`)**
  - Drop the colour-set assertion; keep `reminderAt`.
  - Rename to `'gives the accepted game a reminder'`.

- [ ] **Step 6: A11 (`engine-games.test.ts:44`)**
  - Delete it.
  - Add to `api-engine.test.ts`: `'creates an unrated game even when the body says rated'`. POST with `rated: true` and assert `rated === false`.
  - Mutation: spread the request body into the insert.

- [ ] **Step 7: A13 (`board.test.ts:42`)**
  - Delete the light-square line.
  - Assert the check-highlight colour on the king's square instead, taking the constant from `src/images/board.ts`.

- [ ] **Step 8: A14 (`dm-messages.test.ts:132`)**
  - Add `expect(fake.callsTo('deleteMessage')).toHaveLength(n)` and assert the job count is greater than 0, before the `every`.

- [ ] **Step 9: E (server names)**
  - `telegram-handlers.test.ts:220`: rename to `'… · Declined'`.
  - `api-games.test.ts:209`: rename to drop "accepts". The accept itself is added in Task 5.
  - `engine-move-flow.test.ts:126-131, :164-166`: delete the stale "correction to the brief" comments.

- [ ] **Step 10: Verify, then commit**

  Run the full check. Expected: the server integration files all ran.
  `git commit -m "Fix server tests that could not fail"`, with one mutation line per item.

### Task 4: Mini App and shared tests that can't fail (A8, A9, A12, A15) and their names (E)

**Files:**
- Modify: `apps/miniapp/test/{game.test.tsx,gameStore.test.ts,settings.test.tsx}`
- Modify: `packages/shared/test/{avatar.test.ts,rating/replay.test.ts,flair/catalog.test.ts,chess/premoveTree.test.ts}`

- [ ] **Step 1: A8 (`game.test.tsx:2201`)**
  - Mount with `savesTree(initial)`.
  - Mutation: make the leave guard ignore drafts when confirmations are off; the test must go red.

- [ ] **Step 2: A9 (`gameStore.test.ts:124`)**
  - Use a waiting viewer (`afterPlies(2, …black…)`), call `viewPly(1)`, and assert `buildView.canMove === false`.
  - Rename to `'builds premoves only at the latest position'`.

- [ ] **Step 3: A12 (`avatar.test.ts`)**
  - "ids beyond 2^53": assert `avatarColour('9223372036854775807')` is `'#e17076'` and delete the repeat-call line.
  - `'GrOuPiDxYz'`: pin its exact colour.
  - Mutation: replace `BigInt` with `Number`.

- [ ] **Step 4: A15 (`game.test.tsx:218, :862`)**

  Delete both tests. `e2e/move.spec.ts:20-22` covers this.

- [ ] **Step 5: E (names and brittle setup)**
  - `replay.test.ts:167`: delete it (`:137` covers the starting values).
  - `catalog.test.ts:314`: rewrite as `'rates a total only when asked'`, exercising `total(…, { rated: true })`.
  - `catalog.test.ts:189, :195`: replace the absolute `slice` positions with the relative-order filter pattern from `:141-147`.
  - `premoveTree.test.ts:283`: move the `f1e2` rejection into its own test, `'refuses a move from an empty square'`.
  - `settings.test.tsx:61-62`: delete the two removed-pref lines.

- [ ] **Step 6: Verify, then commit**

  Run the full check. `git commit -m "Fix Mini App and shared tests that could not fail"`, with the mutation lines.

### Task 5: The three gap tests

**Files:**
- Modify: `apps/server/test/integration/api-games.test.ts`
- Modify: `packages/shared/test/chess/arbiter.test.ts`
- Modify: `apps/server/test/integration/migration-0011.test.ts`

- [ ] **Step 1: Draw accept through the API**

  Write `'accepts a draw offer'` in `api-games.test.ts`:
  1. Alice offers.
  2. Bob POSTs `/api/games/:id/draw/accept`.
  3. Expect 200, with `status: 'finished'`, `result: '1/2-1/2'` and `endReason` equal to what the domain sets for an agreed draw (read `src/domain/draws.ts`).
  4. Add the 409 case for accepting with no offer pending.
- [ ] **Step 2: Run them**

  Expected: PASS. These are characterisation tests. Then mutate: return the unchanged game from the accept route. Expected: FAIL. Revert.
- [ ] **Step 3: En passant repetition (protected suite; add only)**

  In `arbiter.test.ts`, add `'does not count a position with an en passant right as a repeat of one without'`:
  - Reach a placement right after a double pawn push where en passant is legal.
  - Then repeat the same placement twice by knight shuffles, where en passant is no longer possible.
  - Assert the repetition count, or threefold claimability, reflects 2 rather than 3 occurrences.
  - Build the line with `applyMove` and check every move's legality with chess.js before trusting it.
- [ ] **Step 4: Run it**

  If it fails, that's a real rule bug: stop, fix `src/chess/arbiter.ts` in its own commit, and report it to the owner. Otherwise mutate the repetition key so it ignores the en passant square. Expected: FAIL. Revert.
- [ ] **Step 5: `migration-0011` journal**

  Change `migrationsBefore0011` to keep only the journal entries with index < 11, instead of removing only 0011. To prove it, temporarily add a dummy `0012` entry to the copied journal in the test. Expected: still green. Remove the dummy.
- [ ] **Step 6: Verify, then commit**

  Run the full check. `git commit -m "Add the draw accept, en passant repetition and migration journal tests"`.

### Task 6: Order dependence and leaks (B)

**Files:**
- Modify: `apps/server/test/integration/{main,bot,scanners,api-premoves}.test.ts`
- Modify: `apps/server/test/unit/staticApp.test.ts`
- Modify: `apps/miniapp/test/stream.test.ts`
- Modify: `apps/miniapp/playwright.config.ts:12`

- [ ] **Step 1: `main.test.ts`**
  - Give the second `startServer` (`:75-87`) its own `FakeTelegram`.
  - Remove the mkdtemp dir in `afterAll`.
  - Prove it: move the second server's test to the top of the file and run. Expected: still green. Move it back.
- [ ] **Step 2: `bot.test.ts`**
  - Build the bot in `beforeEach`, so each test gets a fresh `linkLimiter`.
  - The tests at `:381/:392/:402` can then share one chat id.
  - Replace the `\d+` metrics regex with a before/after counter difference of exactly 1.
- [ ] **Step 3: Bus subscriptions**

  In `scanners.test.ts:43` and `api-premoves.test.ts:318`, keep the returned unsubscribe and call it in `finally`.
- [ ] **Step 4: Temp dirs**

  Add `afterAll(() => rm(dir, { recursive: true, force: true }))` to `staticApp.test.ts`.
- [ ] **Step 5: `stream.test.ts`**
  - `streamWith` pushes each stream to a list; `afterEach` calls `stop()` on each and clears the list.
  - Restore the `visibilityState` override in `afterEach`.
  - Delete the redundant `visibility = 'visible'` at `:102`.
- [ ] **Step 6: Playwright retries**

  Set `retries: 0`.
- [ ] **Step 7: Verify, then commit**

  Run the full check. Then run `pnpm vitest run apps/miniapp/test/stream.test.ts --sequence.shuffle` three times. Expected: green.
  `git commit -m "Remove order dependence and leaked state from tests"`.

## Phase 3: Duplicates and layer moves

### Task 7: Server duplicates (C) and pure tests out of database files (D)

**Files:**
- Modify:
  - `apps/server/test/integration/{api-games,api-premoves,premoves,api-auth,db,engine-job,engine-move-flow,engine-user,photos,payments,users-groups,jobs,flair-backfill,flair-history,flair-award,api-tips}.test.ts`
  - `apps/server/test/unit/{players,users,dmText,engine-protocol,fetch-fonts,snapshot,engine-handler}.test.ts`
- Create: `apps/server/test/unit/{premoveCheck,flairBackfill,jobs}.test.ts`
- Modify (src): `apps/server/src/domain/premoves.ts:16` (drop the `checkTreeYielding` re-export); `apps/server/src/images/board.ts:76` (drop the `isLightSquare` export); `apps/server/src/bot/rateLimit.ts:11` and `apps/server/src/images/fonts.ts:22` (add a comment `// Test seam: …` to each)
- Rename: `integration/legacy-dm-jobs.test.ts` → `integration/migration-0010.test.ts`; `integration/handlers.test.ts` → `integration/core-jobs.test.ts`

For each deletion below, run the mutation check on the surviving copy first (Review Focus 3).

- [ ] **Step 1: Delete the server duplicates**

  The surviving copy is in parentheses:
  - `api-games:410` (survivor: `api-premoves:324`)
  - `api-premoves:199`, `:306-313`, `:418-424`
  - `premoves:78-88`
  - `api-auth:360-367`, and the `process_cpu_*` assertions in `main.test`
  - `db:239-254`, `:256-269`, `:312-331`
  - `engine-job:297` (survivor: `engine-move-flow:212`)
  - merge `engine-move-flow:58` into `:94`, which uses `dmAllowed: true`
  - `engine-user:28`
  - `photos:24, :35, :55`
  - `payments:313`: keep one refusal case
  - `games:77-81`, `:273-275`
  - `api-games:542-543`
  - `dmText:134-143`
  - `engine-protocol:37-39`, and move the "hands out a copy" test into the first `describe`
  - `engine-handler:16-18`: call it once
  - `snapshot:150-157`: one assertion, `key === sha256(svg)`
  - `fetch-fonts:63-72`: keep only the https/sha256 loop
  - `players:40-69`: keep one test that `flair` holds the worn ids
  - `flair-award:351-416`: keep one representative per flair *family* (resigned, timeout, streak) and delete the rest, which `flair-rules` covers
- [ ] **Step 2: Move pure-function tests to unit files**

  Import each from its defining module, not a re-export:
  - `checkTreeYielding` and `hasUncheckedPairs` (from `premoves.test:121-170, 543-550`) go to `unit/premoveCheck.test.ts`.
  - `prefsOf` (from `users-groups:160-173`) goes to `unit/users.test.ts`.
  - `pollBackoffMs` (from `jobs:26-32`) goes to `unit/jobs.test.ts`.
  - `backfillDedupKey`, `canRunBackfill` and `isCountedGame` (from `flair-backfill:313-330` and `flair-history:15-27`) go to `unit/flairBackfill.test.ts`.
- [ ] **Step 3: Drop the test-only exports**

  Drop the re-export and `isLightSquare`, and delete `board.test.ts:19-25`. Add the seam comments.
- [ ] **Step 4: Misplaced tests and renames**

  Move `api-tips:202` under a `describe('DELETE /api/me')`. Do the two `git mv` renames.
- [ ] **Step 5: Verify, then commit**

  Run the full check. Expected: the server test count drops, and the unit project gains 3 files.
  `git commit -m "Delete duplicate server tests and move pure ones to unit"`, with the mutation lines.

### Task 8: Mini App and shared duplicates (C) and internals (D)

**Files:**
- Delete: `apps/miniapp/test/brand.test.ts`
- Merge: `packages/shared/test/enums.test.ts` → `packages/shared/test/protocol/enums.test.ts`; `apps/miniapp/test/choiceDialog.test.tsx` → `dialog.test.tsx`
- Create: `apps/miniapp/test/result.test.ts` (the `sideResult` tests, moved from `board.test.ts:84-120`)
- Modify:
  - `apps/miniapp/test/{game.test.tsx,premoveUi.test.tsx,gameStore.test.ts,router.test.ts,avatar.test.tsx,lobby.test.tsx,groups.test.tsx,flairScreen.test.tsx,linesPanel.test.tsx,games.test.tsx,lobby.test.tsx}`
  - `packages/shared/test/protocol/{dto,requests,callbackData}.test.ts`, `packages/shared/test/chess/premoveTree.test.ts`

- [ ] **Step 1: Delete the Mini App duplicates**
  - `game.test.tsx:2139`
  - `premoveUi.test.tsx` "Replay slider" `:234-292`. `game.test.tsx:389/:1950/:1965` cover it, and Task 12 moves those into `gamePremoves.test.tsx`.
  - `gameStore.test.ts`: merge the `building` assertions at `:38-41`, `:120-127` and `:139-148` into `:250-266`, and delete `:172-174`.
  - `router.test.ts:113-119`
  - `avatar.test.tsx:63-70`
  - `game.test.tsx:305-356`: keep `:305` as the one wiring test, plus "voided offers no rematch"
  - `flairScreen.test.tsx:86, :139, :147` and the date strings at `:100-104`: keep one test that a tap sends the expected PUT and updates the preview
  - `games.test.tsx:100`
  - `brand.test.ts`
- [ ] **Step 2: Avatar values**

  In `avatar.test.tsx:22,26`, `lobby.test.tsx:80` and `groups.test.tsx:24`, assert that an initial and a background are rendered, not the specific hex values or initials.
- [ ] **Step 3: Internals**
  - `linesPanel.test.tsx:117-133`: delete the CSS-parsing test.
  - Swap the CSS-class assertions for the existing attribute:
    - `flairScreen:124` → drop it (`aria-pressed` is already asserted)
    - `newGame:313-314` → `aria-pressed`
    - `supportCard:165/170/195/198` → `aria-invalid`
    - `game.test.tsx:320/322/501-504/1303/1309` → text or `aria-label`, wherever the component exposes one; leave a line as is if none exists, and note it
- [ ] **Step 4: Shared duplicates**
  - Merge `enums.test.ts` into `protocol/enums.test.ts`. Keep only the display-order checks, and drive the accept cases with `it.each([...TIME_PER_MOVE_OPTIONS, null])`.
  - Drop the zod accept/reject halves.
  - `dto:245`: drop the accept-all loop.
  - Keep a single `'AQ+H'` rejection, in `dto.test.ts`.
  - `requests:298`, `requests:376`, `callbackData:240`
  - `premoveTree:48`, `:89`, `:388`
  - `lobby.test.tsx:112`: remove the no-op `router.back()`.
- [ ] **Step 5: Verify, then commit**

  Run the full check. `git commit -m "Delete duplicate Mini App and shared tests"`, with the mutation lines.

## Phase 4: Server scenario builders

### Task 9: Add the builders, adopting them in the files they come from

**Files:**
- Modify: `apps/server/test/helpers/fixtures.ts`, `apps/server/test/helpers/db.ts`, `apps/server/test/helpers/chess.ts`, `apps/server/test/helpers/engineJob.ts`
- Create: `apps/server/test/helpers/worker.ts`, `apps/server/test/helpers/flair.ts`
- Modify (adopt): `games.test.ts` (`setup`, `liveDm`, `secondsUntil`, `resultDms`), `engine-escapes.test.ts` (`gameAwaitingTheEngine`), `flair-award.test.ts` and `flair-backfill.test.ts` (flair helpers, `waitForLockWaiters`), `api-flair.test.ts`, `share-photo.test.ts` (worker bootstrap), `migrate-reset.test.ts` and `migration-0011.test.ts` (scratch DB), `unit/flair-rules.test.ts` and `unit/flair-walk.test.ts` (`countedGame`)

**Interfaces (produced):**

```ts
// fixtures.ts
export type World = { group: GroupRow; alice: UserRow; bob: UserRow; carol: UserRow; game: GameRow };
export function world(db: Db, opts?: { game?: GameOverrides }): Promise<World>;
export function world(db: Db, opts: { game: false }): Promise<Omit<World, 'game'>>;
// alice is White and bob is Black; all three are touchMember'd in that order, then the game is
// inserted (the same rows, in the same order, as today's setup()).
export function played(db: Db, game: GameRow, ucis: string[], start?: string): Promise<GameRow>;
// Replays `ucis` with helpers/chess.ts `play`, inserts the move rows (clientMoveId `fixture-<id>-<ply>`),
// and updates fen and plyCount; returns the updated row.
export function liveDm(db: Db, dm: { userId: number; gameId: number; kind: 'turn' | 'waiting'; stub: string; telegramMessageId?: number }): Promise<void>;
export function secondsUntil(db: Db, column: 'deadline_at' | 'reminder_at', gameId: number): Promise<number | null>;
export function resultDms(db: Db): Promise<number[]>;
// insertMember is deleted.

// db.ts
export function waitForLockWaiters(db: Db, count: number, queryLike = '%for no key update%'): Promise<void>;
export function scratchDatabase(name: string): Promise<{ url: string; db: Db; drop(): Promise<void> }>;

// chess.ts: the real positions (mate, fifty-move, insufficient material) the integration files
// redeclare move here as named exports, alongside the existing ones.
export function countedGame(overrides?: Partial<CountedGame>): CountedGame;

// engineJob.ts (buildJob becomes non-exported)
export function gameAwaitingEngine(deps: Deps, opts: { groupId: number; userId: number; level?: EngineLevel }): Promise<GameRow>;

// worker.ts
export function jobWorker(db: Db, deps: Deps, makeHandlers: (ctx: { api: TelegramApi; config: Config; fonts: Fonts }) => JobHandlers): Promise<{ fake: FakeTelegram; worker: JobWorker; close(): Promise<void> }>;

// flair.ts (moved verbatim from flair-award/flair-backfill, made to take db explicitly)
export function day(d: number): Date;
export function finishedGame(db: Db, g: { groupId: number; whiteId: number; blackId: number; day: number; result: Exclude<GameResult, '*'> }, options?: { line?: readonly string[]; start?: string; over?: GameOverrides }): Promise<GameRow>;
export function earned(db: Db, userId: number): Promise<[string, number | null][]>;
export function worn(db: Db, userId: number): Promise<string[]>;
export function startWearing(db: Db, userId: number, wearing: string[]): Promise<{ commit(): void; done: Promise<void> }>;
```

The builder may adjust these types to what the code needs, for example the real handler-factory type. The function names, and which helpers take `db` explicitly, are fixed: later tasks rely on them.

- [ ] **Step 1: Add the builders and adopt them in their source files**

  Do this one source file at a time. Run that file after each.
- [ ] **Step 2: Verify**

  Run the full check. Expected: the same test count as after Task 8.
- [ ] **Step 3: Commit**

  `git commit -m "Add server scenario builders"`.

### Task 10: Rewrite the domain and API integration files onto the builders

**Files:**
- Modify: `apps/server/test/integration/{premoves,draws,challenges,api-games,api-premoves,scanners,jobs,users-groups,membership,ratings,account,lichess}.test.ts`

**Interfaces:**
- Consumes: `world`, `played`, `liveDm`, `secondsUntil`, `resultDms` and the chess constants (Task 9).

- [ ] **Step 1: Rewrite one file at a time**
  - Replace the local `setup()`/`world()` with `world(db, …)`.
  - Replace FEN constants and `insertMove` pairs with `played(db, game, [...])`.
  - Replace hand-rolled `dm_messages` inserts with `liveDm`.
  - Merge `scanners:76-92` into `:58-73`'s setup, and `draws:44-51` with `:158-162`.
  - Run each file before moving on.
- [ ] **Step 2: Leave the race and idempotency tests alone (Review Focus 1)**

  In `games.test.ts:183/:288`, `challenges.test.ts:215` and `premoves.test.ts:552`, and any test using `holdOpen`, `withoutWaiting` or `Promise.all` on writes, only the setup line changes. Then run each 10 times:

  ```bash
  for i in $(seq 10); do pnpm vitest run apps/server/test/integration/games.test.ts -t "<title>" || break; done
  ```

  Expected: 10 passes for each.
- [ ] **Step 3: Measure, verify, commit**
  1. Record the lines per file before and after (`wc -l`).
  2. Run the full check.
  3. `git commit -m "Rewrite domain and API integration tests onto the builders"`, with the line counts and the race-run note.

### Task 11: Rewrite the engine, flair, photo and Telegram integration files onto the builders

**Files:**
- Modify:
  - `apps/server/test/integration/{engine-games,engine-job,engine-move-flow,engine-draws-rematch,api-engine,flair-history,flair-refs,result-photo,photos,user-photo,telegram-handlers,dm-messages,tip-refunds,payments,core-jobs}.test.ts`
  - `apps/server/test/helpers/snapshotFixtures.ts` (its `AFTER_E4` becomes the only declaration)

**Interfaces:**
- Consumes: all the Task 9 builders.

- [ ] **Step 1: Rewrite one file at a time**
  - Engine files use `gameAwaitingEngine`; the ply-2 setup at `engine-job:198-216/250-268` becomes a call to `played`.
  - `engine-move-flow:98`, `engine-games:107-108`: delete the "guard against a vacuous pass" lines that call `reminderExpression`/`deadlineExpression`. Keep the human control game.
  - `api-engine:118`: drop the stray `timePerMove`.
  - The worker-plus-FakeTelegram files use `jobWorker`.
  - `AFTER_E4` redeclarations import from `snapshotFixtures`, or use `played`.
- [ ] **Step 2: Race tests**

  Same rule and 10-run check as Task 10 Step 2, for `flair-award`'s lock-waiter tests, `user-photo`'s `onFile` races and `api-flair`'s `waitForLockWaiters` test.
- [ ] **Step 3: Measure, verify, commit**

  Same as Task 10. `git commit -m "Rewrite engine, flair, photo and Telegram integration tests onto the builders"`.

## Phase 5: Mini App screen harness

### Task 12: `gameScreen` support and the `game.test.tsx` split

**Files:**
- Create: `apps/miniapp/test/support/gameScreen.tsx`
- Create: `apps/miniapp/test/gameConfirm.test.tsx`, `apps/miniapp/test/gamePremoves.test.tsx`
- Modify: `apps/miniapp/test/game.test.tsx`

**Interfaces (produced):**

```ts
export const GAME = 'AbCdEfGhIj';
export function gameRoutes(initial: GameDto, on?: {
  move?: FakeRoute; premovePut?: FakeRoute; draw?: FakeRoute;
}): FakeRoute;
// Default PUT /premoves answer: 200 with { ...initial, premoveTree: <the body's tree>, premoveTreeHash: <its hash> }
// built the way today's savesTree() builds it. Unknown routes answer 404 (not { ok: true }) so a
// missing route fails loudly.
export function staleState(game: GameDto): FakeResponse; // the 409 stale_state body now copied 9×
export function mountGame(initial: GameDto, opts?: {
  route?: FakeRoute; version?: string; confirmations?: MoveConfirmations; tg?: Tg;
}): Rendered;  // confirmations defaults to 'never'
export function dropAll(r: Rendered, ucis: string[]): Promise<void>;
export function played(...): …; export function putsOf(r: Rendered): …;
export function tokens(r: Rendered): string[]; export function pill(r: Rendered): …;
export function hint(r: Rendered): …; export function slider(r: Rendered): HTMLInputElement;
// played/putsOf/pill/hint keep their current game.test.tsx signatures, moved as they are.
```

`vi.mock` calls stay in each test file. `gameScreen.tsx` exports `adapterRef: { current: StubAdapter }`, which each file's `createBoardAdapter` mock reads. The `PREMOVE_TREE_MAX_CHARS` mock and the `limits` object live only in `gamePremoves.test.tsx`.

- [ ] **Step 1: Create `gameScreen.tsx`**

  Move the helpers into it. `game.test.tsx` imports them. Run the file. Expected: green, with the same count.
- [ ] **Step 2: Fix any test the 404 default breaks**

  The default route now answers 404 instead of `{ ok: true }`. Any test that breaks was relying on that silent answer, as A8 did. Give it the route it actually needs, and list each one in the commit message.
- [ ] **Step 3: Split the file**

  Split by describe. `game.test.tsx` keeps `:99-564`. `gameConfirm.test.tsx` gets `:566-911` and `:2022-2216`. `gamePremoves.test.tsx` gets `:913-2020`; fold the one-test describes at `:1443` and `:1496` into their parents. Each file gets its own `beforeEach`/`afterEach` and `vi.mock` lines.
- [ ] **Step 4: Shorten the tests**
  - Replace the 21 written-out "e5 then Nf3" sequences with `dropAll`.
  - Delete the local shadows of `slider` (`:377`, `:392`).
  - Split `:1253-1273` and `:2004-2019` into one `it` per scenario.
- [ ] **Step 5: Verify**

  Run the full check and e2e. Expected: the test count equals the count before the split, plus the split tests.
- [ ] **Step 6: Commit**

  `git commit -m "Split the game screen tests and share their harness"`, with the line counts.

### Task 13: Remaining Mini App setup

**Files:**
- Modify: `apps/miniapp/test/{stream,yourMove,groupSettings,newGame,boot,miniBoard}.test.ts(x)`

- [ ] **Step 1: Use the shared fixtures**
  - `stream.test.ts:6-52` uses `gameDto({ viewerRole: 'spectator', deadlineAt: null })`.
  - `yourMove.test.ts:11-50` uses `{ ...gameSummary({...}), group }`.
  - `groupSettings.test:15-50` and `newGame.test:10-46` use `playerRef()`.
- [ ] **Step 2: Low-confidence items**

  The design leaves these to the builder: fix each one if cheap, otherwise leave it and note why.
  - `boot.test.ts`:
    - `:105` title
    - `:73/97/120`: fixed 10 ms sleeps → `vi.waitFor`
    - `:225-229`: hard-coded hex → `ACCENTS`
  - `miniBoard.test:20-21`: `classList.contains` instead of `className toContain`.
  - Also in this bucket: `gameCard.test.tsx:10-20` (the `chessground/fen` parse-count mock), `apps/server/test/unit/dmRules.test.ts:8-10` (the constant test) and splitting `apps/server/test/unit/telegram-client.test.ts:21-35` into `links.test.ts`.
- [ ] **Step 3: Verify, then commit**

  Run the full check. `git commit -m "Use shared fixtures across the Mini App tests"`.

## Phase 6: Documentation

### Task 14: `docs/testing.md`, and before/after numbers

**Files:**
- Modify: `docs/testing.md`

- [ ] **Step 1: Update the counts**

  Update the table in "What runs where" with the real counts from `pnpm test` and `pnpm e2e`.
- [ ] **Step 2: Add "Test helpers" after "What each layer owns"**
  - One line per builder: server `world`, `played`, `liveDm`, `jobWorker`, `gameAwaitingEngine` and `helpers/flair.ts`; Mini App `mountGame`, `gameRoutes` and `dropAll`.
  - The two rules: one wiring test above the layer that owns a behaviour, and `it.each` only for data-only variation.
- [ ] **Step 3: Add to "Practice"**

  A paragraph on the unsupported-call check. Write a fallback test as the positive behaviour only. The global check catches any ungated call. Use `allowUnsupported` only with a reason.
- [ ] **Step 4: Correct the arbiter claim**

  The en passant repetition case exists now (Task 5); confirm the wording matches what was added.
- [ ] **Step 5: Gather the before/after numbers**

  Per package: test count, test lines (`wc -l` over the test dirs), and setup lines in the rewritten files (from the Tasks 10–12 commit messages). Put them in the commit message and the final report to the owner.
- [ ] **Step 6: Verify, then commit**

  Run the full check (`format:check` covers the doc). `git commit -m "Update the testing doc for the cleaned-up suite"`.
