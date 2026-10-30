# Test suite cleanup

Status: draft, awaiting owner approval, 2026-10-30. The audit this design acts on is in the appendix. Item ids such as A4
and C3 refer to it.

## Why

The suite has grown to 126 files and 1,510 tests, which take about 4 minutes to run against
Postgres. An audit of every file found two problems.

- **Trust.** A dozen or so tests can't fail for the reason their name gives. The Mini App's fake
  Telegram client reproduces the version gating it is meant to check, so most of the "older client"
  tests prove nothing.
- **Volume.** About 30 tests are duplicates, and roughly a dozen pure-function tests sit in
  database-backed files. Most integration and screen tests open with 10–30 lines of hand-copied
  setup: a group and three members, a live DM row, an engine-move preamble, a "drop e5 then Nf3"
  sequence. Every one of those copies has to be edited when the behaviour changes.

The owner wants both fixed, trust first, and wants the suite to end up smaller with less setup per
test. They asked for an ambitious refactor.

## Goals, non-goals, anti-goals

**Goals**

- Every test named for a behaviour fails when that behaviour breaks.
- The fake Telegram client behaves like the real `telegram-web-app.js` on old versions, and the
  harness catches an ungated call in *every* test, not just the fallback tests.
- Fewer tests and fewer lines. Each behaviour is asserted once, at the lowest layer that can see it,
  plus one wiring test above it where the layers meet.
- A test's starting state reads as one line of scenario, not a page of inserts.
- Close the three gaps the audit found:
  - accepting a draw through the API;
  - the en passant repetition case that `docs/testing.md` claims;
  - `migration-0011.test.ts` breaking once 0012 exists.

**Non-goals**

- Coverage percentages or tooling. `docs/testing.md` deliberately doesn't collect coverage.
- Changing product code, except removing exports that exist only for tests (D) and fixing any real
  bug a corrected test exposes. Such a bug gets its own commit and is reported to the owner.
- Speeding up the test runner (`isolate: false` and the like). That may happen as a side effect, but
  it isn't pursued.
- Rewriting the e2e suite. It is only touched for fallbacks (A1) and retries (B).

**Anti-goals**

- Weakening the suites `docs/testing.md` protects: arbiter rules, Glicko-2, PGN, the `initData`
  validator, the integration races and idempotency tests, and the `moveMachine` reducer edges.
  Duplicates inside them may be merged; no case may be lost.
- Builders that hide what a test depends on. If a reader can't tell from the test what position,
  roles or preferences it starts from, the builder is too clever.
- Table-driven tests whose rows read as data rather than behaviour. `docs/testing.md` relies on test
  names to say what a change is supposed to do.
- A red commit. The suite stays green after every commit, because the owner may stop at any phase.

## Constraints

- The server integration tests need `TEST_DATABASE_URL` and run with `fileParallelism: false`.
  Without the variable only the unit tests run, which makes it easy to "pass" by accident. Every
  phase is verified with the full suite against Postgres (`scripts/local-postgres.sh start`).
- `vi.mock` is hoisted only from the test file itself. When `game.test.tsx` is split, each new file
  keeps its own `vi.mock` lines; only plain helpers move into `support/`.
- No test may assert a specific engine move, evaluation or strength (`docs/testing.md`). All engine
  tests stay on `fakeEngine`.
- Preact 11: the first render must run inside `act()` (see Phase 1).

## Approaches considered

- **A. Move copies into helpers.** Hoist literally duplicated functions into `helpers/` and
  `support/` as they are, and split `game.test.tsx` along its describes. Low risk, but setup only
  shrinks where code was copied word for word.
- **B. Scenario builders (chosen).** A small set of builders that state a test's starting state in
  one call, for example `world()`, `played()`, `gameAwaitingEngine()` and `mountGame()`, with tests
  rewritten onto them. This removes most setup, not just the copied parts. The risk is a builder that
  hides too much, which the anti-goals and the builder rules below address.
- **C. B, plus table-driven tests everywhere.** This cuts the most volume, but it works against the
  behaviour-named tests the project relies on.

The owner chose **B**. `it.each` is allowed only where cases differ by data alone and the name
template still reads as a behaviour, for example "refuses a tip of $amount", the per-version
fallbacks, and the refusal cases in `tips.test.ts`.

## Design

The work goes in six phases, in this order. Each phase is one or more commits on
`claude/friendly-lovelace-c2r30f`, and the suite is green after each commit.

### Phase 1: Harness fidelity (A1, A2, A3, A16)

**The fake Telegram client** (`apps/miniapp/test/support/fakeWebApp.ts`).

1. Every method and object the app uses exists on every version, as in the real SDK.
2. Below a method's minimum version, a call does what the real `telegram-web-app.js` does for that
   method. For some it throws `WebAppMethodUnsupported`; for others it logs a warning and does
   nothing. Either way the fake records `{ unsupported: '<name>' }`.
3. The builder checks each method's behaviour against the real script, not from memory.
   - *Builder's call:* telegram.org is blocked from the build environment, so the reference is the
     verbatim copy that `@twa-dev/sdk@8.0.2` ships as `src/telegram-web-apps.js`.
   - That copy has 52 version guards. For example, `showPopup` logs an error and throws, while
     `HapticFeedback` warns and returns.
   - Fetch it with `npm pack` into a scratch directory. Don't add it as a dependency or commit it.
   - Name the source and version in the fake's header comment, so later contributors can re-check
     it.
4. A global Mini App vitest `setupFiles` hook gets an `afterEach` that fails the test if any
   unsupported call was recorded.
   - *Builder's call:* it goes in `setupFiles` rather than in `renderApp`, so it also covers
     `tg.test` and `boot.test`, which install the fake directly.
5. A test that deliberately exercises an ungated path can opt out with
   `allowUnsupported('<name>')`. No current test should need it.
6. The per-test "below version X it does nothing" assertions in `tg.test`, `boot.test` and
   `e2e/fallbacks.spec` are then redundant and are deleted. Each fallback test keeps only its
   positive claim, for example "uses the in-page sheet below 6.2".
7. `openLink` and `openTelegramLink` record separately.

**The e2e fake.** The e2e suite uses the same fake through its harness, so the same recording
applies there. The fallbacks spec asserts that the fake recorded no unsupported calls, instead of
reading `secondaryButton === null`.

**Render timing** (`apps/miniapp/test/support/render.tsx`). The first `render(...)` runs inside
`act()`, so effects have run by the time `renderApp` returns. The workaround flushes and the
"effect-timing quirk" comments are then removed wherever a test still passes without them.
`settings.test.tsx:143` (A3) is then correct as written; check that it fails if the cancel is
ignored.

### Phase 2: Tests that can't fail, and the gaps (A4–A15, E)

Fix each A item as the appendix describes. For every fixed test, the builder proves it can fail:

1. Temporarily break the behaviour in `src`, for example by commenting out the deadline update.
2. Watch the test go red.
3. Restore the code.

The commit message lists the check made for each test. A test whose behaviour can't be broken
without breaking ten others is fine; note it.

In the same phase:

- Fix the misleading names in E.
- Add the three gap tests:
  - `/draw/accept` through the API, in `api-games.test.ts`;
  - an en passant repetition case in `arbiter.test.ts`, where a position after a double pawn push
    is not identical to the same placement without the en passant right, and the count follows;
  - in `migration-0011.test.ts`, cut the journal *at* 0011 rather than removing only 0011.
- Fix the order-dependence and leaks in B, and set Playwright `retries: 0`.

### Phase 3: Duplicates and layer moves (C, D)

- Delete the duplicates in C, keeping the stronger copy each time.
- Where a behaviour is asserted at both unit and integration level, the integration copy is cut to
  one wiring test. Examples: the tips refusal cases, the photo outcomes, the flair rules repeated in
  `flair-award`.
- Move the pure functions out of the database-backed files into `test/unit/` (D), importing from
  the module that defines them.
- Drop the exports that exist only for tests: the `checkTreeYielding` re-export and
  `isLightSquare`. Comment `rateLimit.size` and `FONT_FILES` as deliberate test seams.
- Delete `brand.test.ts`.
- Merge `packages/shared/test/enums.test.ts` into `protocol/enums.test.ts`, keeping only the
  display-order checks and the `TIME_PER_MOVE_OPTIONS` drift check.

### Phase 4: Server scenario builders

New or extended files in `apps/server/test/helpers/`. Every builder returns plain rows and takes
explicit overrides. None reads module-level state or registers hooks.

- **`world(db, { game?, members? })`** in `fixtures.ts`.
  - Creates a group with Alice (white), Bob (black) and Carol (a member who isn't playing), all
    `touchMember`'d.
  - Optionally creates their game, with `GameOverrides`; `game: false` skips it.
  - Returns `{ group, alice, bob, carol, game }`.
  - Replaces the `setup()` and `world()` copies in games, premoves, draws, challenges, api-games,
    api-premoves and others.
- **`played(db, game, ['e2e4', 'e7e5', …])`** in `fixtures.ts`.
  - Applies the moves with the shared `applyMove`.
  - Inserts the move rows and updates the game's `fen` and `plyCount`.
  - Replaces the hand-written FEN constants and `insertMove` pairs. The few FENs that are really
    positions (mate, fifty-move, insufficient material) move to `helpers/chess.ts` with the existing
    `LINES`.
- **`liveDm(db, { userId, gameId, … })`** in `fixtures.ts`. Replaces the seven hand-rolled
  `dm_messages` inserts.
- **`jobWorker(db, { engine? })`**, new in `helpers/worker.ts`. Returns
  `{ fake: FakeTelegram, worker, close }` for the worker-plus-FakeTelegram bootstrap repeated in
  five files.
- **`gameAwaitingEngine(db, …)`** in `engineJob.ts`. Replaces the e2e4 preamble that appears about
  15 times across the engine files.
- **`helpers/flair.ts`**: `finishedGame`, `earned`, `worn` and `day`, taken from flair-award and
  flair-backfill.
- **`waitForLockWaiters(db, count, filter?)`** in `db.ts`.
- **`scratchDatabase()`** in `db.ts`, for the two migration files.
- **`countedGame()`** in `chess.ts`, for the two flair unit files.
- **Helpers to delete or narrow:** delete `insertMember`; make `buildJob` non-exported.
- **Local helpers:** `secondsUntil` and `resultDms` move into `fixtures.ts` or `db.ts`.

All existing integration files are then rewritten onto these builders.

*Builder's call:* the race and idempotency tests are protected, but they live in the same files and
share the same `setup()`. They change only their setup line, and only where the builder inserts the
same rows in the same order, as `world()` does for today's `setup()`. Their bodies are left
untouched. After the rewrite, each one is run with `--repeat`/a loop of at least 10 to show it still
behaves the same.

### Phase 5: Mini App screen harness and the `game.test.tsx` split

New file `apps/miniapp/test/support/gameScreen.tsx`:

- **`gameRoutes(initial, { onMove?, onPremovePut?, onDraw? })`**
  - Replaces `okRoute`.
  - Its default PUT `/premoves` answer is a valid `GameDto` carrying the saved tree. This fixes A8 at
    the root rather than in one test.
  - Includes the `stale_state` 409 builder that is copied 9 times today.
- **`mountGame(initial, { route?, version?, confirmations?, tg? })`**
  - Replaces the per-file `mount`.
  - `confirmations` defaults to `'never'`, as today's `wantPrefs` does, and each describe states it
    explicitly when it differs.
- **`dropAll(r, ['e7e5', 'g1f3'])`**, plus `played()`, `putsOf()`, `tokens()`, `pill()`, `hint()`
  and `slider()`. These are hoisted from `game.test.tsx`.

Split `game.test.tsx` along its describes:

| New file | Contents | Approx. lines |
|---|---|---|
| `game.test.tsx` | core screen, bars, icon bar, finished game, replay | ~470 |
| `gameConfirm.test.tsx` | "with move confirmations" plus "leaving with an unconfirmed draft" | ~540 |
| `gamePremoves.test.tsx` | all premove describes, plus `premoveUi`'s "Replay slider" block (C), with one-test describes folded into their parents | ~1,100 |

The `PREMOVE_TREE_MAX_CHARS` mock lives only in `gamePremoves.test.tsx`. The line counts are
before the builders shrink them.

Also in this phase:

- `stream.test.ts` and `yourMove.test.ts` use `gameDto()` and `gameSummary()` instead of their
  hand-copied fixtures.
- `groupSettings` and `newGame` use `playerRef()`.
- CSS-class assertions are replaced with the `aria-*` or `data-*` attribute that already exists,
  wherever one does (D).

### Phase 6: Documentation

Update `docs/testing.md`:

- Correct the counts.
- Add a short "Test helpers" section naming the builders and the two rules: one wiring test above
  the layer that owns a behaviour, and `it.each` only for data-only variation.
- Describe the fake client's unsupported-call check, since it changes how a contributor writes a
  fallback test.

## How success is judged

- `pnpm test` with `TEST_DATABASE_URL` set, plus `pnpm typecheck`, `pnpm lint` and
  `pnpm format:check`, are green after every commit. `pnpm e2e` is green after Phases 1, 2 and 5,
  which touch it.
- Every Phase 2 fix has been seen to fail against broken code.
- Before and after numbers are reported per package: test count, test lines, and lines of setup in
  the files rewritten onto builders. There is no numeric target. Cuts are made by the rules above,
  not to hit a figure.
- No protected suite loses a case. A diff of `it(` titles in those files shows only renames and
  merges, each named in a commit message.

## Left to the builder

- Exact builder signatures and names, within the rules above.
- Which copy of a duplicate survives, when both are equally strong.
- Whether to add `afterAll` cleanup for temp dirs, or use a shared `tempDir()` helper.
- Commit granularity within a phase.
- Low-confidence audit items (the gameCard `chessground/fen` mock, the 10 ms sleeps in `boot.test`,
  the `dmRules` constant test): fix them if cheap, leave them if not, and say which.
- If a corrected test exposes a real product bug: fix it in its own commit with its own test, and
  tell the owner.

## Delivery

Commits per phase on `claude/friendly-lovelace-c2r30f`, pushed as they land. A pull request is
opened only when the owner asks for one.

---

## Appendix: audit findings

Baseline: `pnpm test` with a real Postgres runs **126 files and 1,510 tests**, all passing, in 257 s.
`docs/testing.md` says 1,067, so its counts are stale.

Six reviewers read every unit, integration and component test file in full and compared each one
with the source. Items marked ✔ were checked again by hand. Line numbers are approximate.

---

### A. Tests that pass for the wrong reason or can't fail (fix first)

| # | Where | Problem |
|---|---|---|
| A1 ✔ | `miniapp/test/support/fakeWebApp.ts` | The fake drops methods below their minimum version (HapticFeedback, SecondaryButton, showPopup…), and the app guards every call with `?.`. So every "below version X" assertion in `tg.test`, `boot.test` and `e2e/fallbacks.spec` would still pass with the app's `supports()` checks deleted. The real `telegram-web-app.js` defines every method and warns or throws on old clients. **This is the biggest single finding.** |
| A2 | `miniapp/test/support/render.tsx` | Since Preact 11 the first render isn't wrapped in `act()`, so effects are deferred. That's the cause of the scattered bare `await r.flush()` calls and the "effect-timing quirk" comments, and of A3. |
| A3 ✔ | `miniapp/test/settings.test.tsx:143` | The first Delete click happens before the popup host registers, so `answerPopup('cancel')` does nothing and "nothing written" passes without anything being cancelled. |
| A4 ✔ | `server/integration/games.test.ts:116` | "resets the opponent's clock": the fixture already sets the deadline to 24 h, so `> 86_390` passes even if `playMove` never touches it. |
| A5 ✔ | `server/integration/telegram-handlers.test.ts:258` | "skips users who declined DMs": Bob also isn't on move, and `gameDm` returns null for that alone, so the DM preference is never tested. |
| A6 | `server/integration/engine-user.test.ts:15` | `truncateAll` re-inserts the engine user, so "exists after migration, exactly once" tests the helper, not the migration. |
| A7 | `server/integration/share-photo.test.ts:224` | Shares at plies 0, 1 and 2 all caption "move 1", and nothing checks the image, so the test passes if the ply is ignored. `:252` says "once the share was sent" but only runs the bot-left case. |
| A8 | `miniapp/test/game.test.tsx:2201` | With confirmations off, the auto-save PUT gets `{ok:true}` from `okRoute`, fails to parse and drops the draft on the error path. The test passes for the wrong reason. Fix: mount with `savesTree`. |
| A9 | `miniapp/test/gameStore.test.ts:124` | "builds only at the latest position" uses a player who is on move and asserts `canMove`, so the claim in the name is never tested. |
| A10 | `server/integration/challenges.test.ts:185` | "random colour": `Set{white,black} == Set{alice,bob}` holds for any assignment. |
| A11 | `server/integration/engine-games.test.ts:44` | "forces unrated even when the caller asks for rated": the caller can't pass `rated`, so the test repeats `:34`. |
| A12 | `shared/test/avatar.test.ts` ("ids beyond 2^53") | It only checks the colour is in the palette, so the `Number()` precision regression it's named for would still pass. Pin the exact colour. |
| A13 | `server/unit/board.test.ts:42` | It asserts the light-square colour, which every board contains, so it says nothing about the check highlight. |
| A14 | `server/integration/dm-messages.test.ts:132` | `every(job => doneAt)` is true when there are no jobs. |
| A15 | `miniapp/test/game.test.tsx:218, :862` | "stays on the game when launched from a link/card": `launchedFrom` is no longer read anywhere, and `closed === false` can't fail. e2e covers this. |
| A16 | `miniapp/test/support/fakeWebApp.ts:300` | `openLink` and `openTelegramLink` record into the same list, so tests can't tell which one the app used. |

### B. Order dependence and leaking state

- `server/integration/main.test.ts:52–102`: a second `startServer` shares the same FakeTelegram. The earlier tests pass only because they are declared first.
- `server/integration/bot.test.ts:135`: one bot (and one rate limiter) is shared by all tests, dodged by using different chat ids. The metrics regex `\d+` matches any count.
- `miniapp/test/stream.test.ts:83–157`: streams are never stopped, so `visibilitychange`/`online` listeners pile up on the real document.
- `server/integration/scanners.test.ts:43`, `api-premoves.test.ts:318`: bus subscriptions are never unsubscribed.
- Unremoved temp dirs: `server/unit/staticApp.test.ts`, `main.test.ts`.
- `miniapp/playwright.config.ts`: `retries: 1` on CI goes against the "no retries" rule in `docs/testing.md`.

### C. Duplicates (delete one copy)

**Server**
- `api-games.test.ts:410` ⊂ `api-premoves.test.ts:324`; `api-premoves` `:199`, `:306`, `:418` repeat shared or domain tests; `premoves.test.ts:78` repeats shared `premoveTree.test.ts:118`.
- `api-auth.test.ts:360` repeats `main.test.ts` healthz/readyz/metrics. Both also assert prom-client's own `process_cpu_*`.
- `db.test.ts`: the dedup index and charge-id uniqueness are covered through behaviour in `jobs`/`payments`. `:256` tests the `insertGame` fixture itself.
- `engine-job.test.ts:297` = `engine-move-flow.test.ts:212`; `engine-move-flow :58` ⊂ `:94`; `engine-user :28` ⊂ `api-engine :48`.
- `photos.test.ts` `:24/:35/:55` repeat `user-photo.test.ts`. `payments.test.ts:313` repeats unit `tips.test.ts:42`.
- `players.test.ts:40–69` vs `users.test.ts:31–51`: both test `wornFlair` through thin wrappers. `dmText.test.ts:134` really tests `nameWithFlair`.
- Font file names are pinned in both `fetch-fonts.test.ts` and `fonts.test.ts`.

**Mini App**
- `game.test.tsx:2139` ⊂ `:796`.
- The "Replay slider" tests in `premoveUi.test.tsx` repeat `game.test.tsx` tests.
- `gameStore.test.ts`: `building` is asserted in four tests, and `:172` = `:96`.
- Result tags are tested at three layers (`board.test`'s `sideResult`, `game.test` DOM, `e2e/replay`).
- `router.test.ts:113` = first half of `:214`; `avatar.test.tsx:63` = `:20`.
- `flairScreen.test` re-tests `wearFlair`/rollback/date strings from `flairState.test`.
- `brand.test.ts` (whole file): it restates constants already covered by `settings.test`.

**Shared**
- `test/enums.test.ts` and `test/protocol/enums.test.ts` test the same module; the zod accept/reject halves test zod.
- `MoveConfirmationsSchema` membership is tested 3×, and the `'AQ+H'` premove rejection 3×, across dto/requests/enums.
- `premoveTree.test.ts` `:48`, `:89`, `:388` are covered by stronger assertions nearby.

### D. Tests in the wrong layer or reaching into internals

- Pure functions in database-backed files: `checkTreeYielding`/`hasUncheckedPairs` (`premoves.test`, plus a re-export only for that test), `prefsOf` (`users-groups`), `pollBackoffMs` (`jobs`), `backfillDedupKey`/`canRunBackfill`/`isCountedGame` (flair-backfill/history). Move them to unit tests.
- Exports that exist only for tests: `isLightSquare` (delete the test and the export), `FONT_FILES`, the `rateLimit.size` getter (a reasonable seam; add a comment saying so).
- CSS-class assertions where an `aria-*` attribute already exists: `flairScreen`, `newGame`, `supportCard`, `game.test` (`won`, `yours`, `.black/.white`). `linesPanel.test.tsx:117` regex-parses `styles.css`.
- Mini App tests re-pin the shared avatar palette hex values and initials.

### E. Stale or misleading

- Wrong names: `telegram-handlers :220` ("still pending" but it's declined); `replay.test :167`; `catalog.test :314` (the "unless asked" path is never exercised); `premoveTree :283`; `api-games :209` (never calls `/draw/accept`, and nothing at the API level does, which is a **coverage gap**).
- `settings.test :61` asserts that two removed prefs are absent.
- `legacy-dm-jobs.test.ts` is really a migration-0010 test. `migration-0011.test.ts` will break once 0012 exists (it removes only 0011 from the journal).
- `handlers.test.ts` tests the core jobs; rename it so it isn't confused with telegram-handlers.
- `catalog.test :189/:195` pin absolute list positions, against the file's own "add anywhere" rule.
- `docs/testing.md` counts are stale. It also claims an en passant repetition case that the arbiter suite doesn't actually have (**add it; don't weaken**).

### F. Copy-paste that belongs in helpers (larger refactor)

- **Server:** `setup()`/`world()` (a group, three members and a game) in 6 files; live-DM inserts in 7 places; FEN constants redeclared 17×; the flair `finished/earned/worn/day` helpers and `waitForLockWaiters` duplicated; the engine "e2e4 then wait for the engine" preamble about 15×; the worker+FakeTelegram bootstrap in 5 files; the scratch-database setup in both migration files; the `CountedGame` factory in two flair unit files. There's also a dead helper: `insertMember`.
- **Mini App:** `game.test.tsx` (2,216 lines) splits cleanly along its describes: core screen (~470), confirmations and leaving (~540), premoves (~1,100). The shared harness would move to `support/gameScreen.tsx`. Also: "e5 then Nf3" is written out 21×, and `stream`/`yourMove` hand-copy fixtures that `support` already provides.

### What's fine (don't touch)

The race and idempotency integration tests, the arbiter, Glicko-2, PGN and initData suites, the `moveMachine` reducer suite, the unit/integration split for draws, and the e2e specs. The reviewers agreed the suite is well-kept and behaviour-focused. The debt is mostly harness fidelity (A1, A2), a dozen tests that can't fail, and copy-paste.
