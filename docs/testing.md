# Testing

How this project is tested, what each layer owns, and the work that still has to happen before the
alpha can exit. The layers and their required cases come from the technical design §15; the alpha
exit criteria come from PRD §13.

## What runs where

| Layer | Command | Size | Runs on |
|---|---|---|---|
| Unit — shared rules and protocol | `pnpm test` | 292 tests, 17 files | every pull request |
| Unit — server | `pnpm test` | 254 tests, 31 files | every pull request |
| Integration — server on real PostgreSQL and a fake Bot API | `pnpm test` | 455 tests, 43 files | every pull request |
| Unit — Mini App on happy-dom | `pnpm test` | 477 tests, 38 files | every pull request |
| End-to-end — Playwright on Chromium with touch emulation | `pnpm e2e` | 29 specs, 12 files | every pull request, pushes to `main`, manual dispatch |
| Image smoke — build, boot, probe, stop | `.github/workflows/e2e.yml` `docker` job | 1 scenario | every pull request, pushes to `main`, manual dispatch |
| Bundle budget | `pnpm build && pnpm check:budget` | 2 budgets | every pull request |
| Licence allow-list | `pnpm check:licences` | 191 npm packages | every pull request |
| Dependency advisories | `pnpm audit --prod --audit-level=high` | — | every pull request |

`pnpm test` is 1478 tests; with PostgreSQL, a local run takes about four minutes. Integration tests need `TEST_DATABASE_URL`; without
it only the unit projects run, which is a silent reduction in coverage, so CI always sets it.
The server's test setup downloads the snapshot card's fonts on first run
(`scripts/fetch-fonts.mjs`, checksummed), so the first `pnpm test` on a fresh clone needs network
access. A local `pnpm e2e` needs them too, since its harness boots the job worker: run `pnpm fonts`,
or `pnpm test` once, first.

Local setup is one command. `scripts/local-postgres.sh start` creates both databases on port 54329
and prints the two exports.

**No CI runner installs Stockfish.** Every test above — unit, integration and end-to-end — runs
against `fakeEngine`, a scripted stand-in that never spawns a real process. The real Stockfish
binary is covered in exactly two non-test places: the Dockerfile's build-time assertion
(`scripts/assert-engine.mjs`, run in the runtime stage against the binary that actually ships) and
the image smoke job in `.github/workflows/e2e.yml`, which probes `engine_available` on the built
image. **No test may assert a specific engine move, an evaluation, a mate score, or that a level
plays at its labelled strength** — those are Stockfish's behaviour, not this project's, and they
change between versions. What is ours to test, and what every layer above does test, is the UCI
options this project sends for each level, engine games staying unrated and off the leaderboard,
the illegal-move fallback, and the rest of spec §9's failure modes — all against the fake. The
end-to-end suite plays one whole bot game through the composed stack (picker, endpoint, job row,
worker, handler, `playMove`, SSE) because `startServer` takes the engine as an optional argument and
the harness passes `fakeEngine`; it asserts that the bot answered, never what it answered.

**What the real binary was checked to do, by hand, once.** On 2026-09-22, `stockfish=15.1-4` in
`node:22-bookworm-slim` was run directly and its session output read. It declares and accepts
`Skill Level` (spin, 0–20), `UCI_LimitStrength` (check) and `UCI_Elo` (spin, 1350–2850), embeds the
NNUE network, and installs and answers on both `linux/amd64` and `linux/arm64`; a deliberately bogus
option in the same session came back as `No such option: …`, which is what makes the absence of that
line for the real three meaningful. This is not a test and must not become one — it is Stockfish's
behaviour, not ours, and it changes between versions. What guards it in production instead is a
warning: `uciEngine` watches the session output for `No such option` and logs the option's name, so a
renamed option degrades loudly rather than silently making two levels play alike (spec §13).

## What each layer owns

**Unit tests own the rules.** The arbiter suite covers every case the design names: fivefold and
75-move detection, threefold and fifty-move claimability, the en passant repetition case, the
insufficient-material table, checkmate taking precedence over the 75-move rule, and mandatory
promotion. Glicko-2 is pinned against the paper's worked vector, plus inactivity inflation, the
floor and ceiling, and the rule that a void rebuild equals a fresh computation. PGN round-trips
through chess.js. The `initData` validator is tested with a good vector, a tampered hash and a stale
`auth_date`. These are the tests that must never be weakened; a rule bug reaching players is the one
alpha exit criterion with no tolerance.

**Integration tests own the races.** Two moves arriving at once, a move racing the forfeit scanner,
two accepts of one open challenge, an idempotent move retry, webhook idempotency and its stale
re-claim, job dedup and coalescing, outbound pacing and 429 handling, the membership ladder with and
without admin rights, and delete-my-data. They run against real PostgreSQL because every one of
those guarantees is a transaction or a lock, not application logic.

**Mini App unit tests own the move state machine.** The reducer is pure and tested to its edges:
confirm twice sends once, the retry ladder keeps one client move id, a drop while sending is
ignored. The board is behind an adapter seam, so screen logic is tested without a real chessground.

**End-to-end owns the seams nothing else can reach.** Drag and tap-tap moves, promotion through the
chooser, confirm and cancel, a spectator who cannot lift a piece, viewing an earlier position and
returning, the replay slider, a live update between two browser contexts, version fallbacks on a
simulated 7.0 client, and reconnection after the connection drops. They run against the real server
on a fake Bot API, so they exercise the actual HTTP and SSE paths.

**What no layer owns:** anything that needs real Telegram. Client version differences, the real
Bot API's rate limiting, drag reliability on real touch hardware, and whether BotFather is set up
correctly are all outside the automated suite by construction. That is what the device matrix below
is for.

## Test helpers

Setup lives in builders, so a test states its starting position in a line or two. Each builder
returns plain rows or objects and takes explicit overrides; none registers hooks or hides what the
test depends on.

**Server** (`apps/server/test/helpers`):

- `world(db, { game?, telegramIds?, verified? })`: a group with Alice, Bob and Carol as members, and
  Alice's game against Bob (White and Black; Carol watches). `game: false` leaves the game out.
- `played(db, game, ['e2e4', 'e7e5'])`: replays moves onto a game with the shared arbiter, inserting
  the move rows and moving the position on. Prefer it to a hand-written FEN.
- `liveDm`, `secondsUntil`, `resultDms`; the common positions (`AFTER_E4`, `BEFORE_SCHOLARS_MATE`…)
  in `chess.ts`, with `countedGame` and `deepLine`.
- `gameAwaitingEngine(deps, { groupId, userId })`: an engine game after 1.e4, the engine to move.
- `jobWorker(deps, handlers)`: a fake Telegram and a job worker whose handlers call it.
- `flair.ts`: `finishedGame`, `earned`, `worn`, `startWearing`, `day`.
- `waitForLockWaiters` and `scratchDatabase` in `db.ts`, for the lock and migration tests.

**Mini App** (`apps/miniapp/test/support/gameScreen.tsx`): `mountGame`, `gameRoutes` (the server for
a game screen; anything it does not route answers 404, so a forgotten route fails loudly),
`dropAll`, `staleState`, `useConfirmations`, and the premove fixtures. The game screen's tests are
split by subject: `game`, `gameConfirm` and `gamePremoves`.

Two rules keep the suite small:

- **Each behaviour is tested once, where it lives**, plus one wiring test in the layer above. A
  rule in `packages/shared` is not re-tested in the server or the Mini App; a pure function is
  tested in `test/unit`, not through the database.
- **`it.each` is for cases that differ by data alone**, and its title template still says what
  the behaviour is.

## Gaps to close before alpha exit

Three items the design asks for do not exist yet. None blocks the merge; all three block the alpha
exit decision.

### 1. Load profile (k6) — not built

The design asks for ten times the target load: 25 moves per second for 10 minutes with 2,000 open
SSE streams, holding server p95 move latency under 300 ms with no growth in `jobs_pending`.

Design for the script, when someone builds it:

- **Seed** a group with 4,000 users and 2,000 active games through the harness API, not the bot, so
  no Bot API calls are made.
- **Two scenarios in parallel.** A constant-arrival-rate scenario posting moves at 25/s against
  random games, and a per-VU scenario opening 2,000 `/events` streams and holding them.
- **Point the Bot API at a null sink**, or run `ROLES=api` only, so the test measures the API and
  the database rather than Telegram's rate limiter.
- **Thresholds that fail the run**: `http_req_duration{name:move} p(95) < 300ms`, and a check that
  scrapes `/metrics` at the end and asserts `jobs_pending` has not grown beyond its starting value.
- **What it is really testing**: the per-group advisory lock on rating writes and the move
  transaction. Expect those to be the first thing to bend.

This needs a deployed environment with a real database; it is not a CI job.

### 2. Lighthouse budget — not built

The byte budget in CI (71 KB of 120 KB gzipped today) is only a proxy for what the design actually
asks: first board paint under 2 s on a throttled mobile profile. The blocking `telegram.org` script
in the document head is outside the byte budget entirely, so the proxy cannot see the thing most
likely to be slow.

Run Lighthouse against the staging `/app/` URL once staging exists, on a throttled 4G mobile
profile, and record the number. This is written into `docs/operations.md` as a before-beta step.

### 3. Device matrix — manual, not yet run

This is the gate on "drag reliability confirmed", and it needs real hardware and a real bot. The
script below is the whole test; it takes about 30 minutes per device.

**Devices:** iPhone with current Telegram, Android with current Telegram, Telegram Desktop, Telegram
Web K, Telegram Web A.

**Per device:**

1. **50 drag moves without a missed drop.** Open a game, make 50 moves by dragging. Count any drop
   that does not register or lands on the wrong square. The bar is zero. Tap-tap 10 more.
2. **Card to move.** From the group card, tap through to the game, move, and confirm the app stays
   on the board with the move shown.
3. **Background and resume.** Leave the app for five minutes with the opponent moving meanwhile.
   Reopen. The latest position must be there without a manual refresh.
4. **DM buttons.** Confirm the turn DM arrives, and that both its buttons land in the right place.
5. **Promotion and confirm.** One promotion through the chooser, one move cancelled at the confirm
   step.

**Record:** device, Telegram version, missed drops out of 50, and anything that looked wrong. A
missed drop on any device is a release blocker, not a known issue.

## Alpha exit criteria and how each is measured

| Criterion (PRD §13) | Measured by |
|---|---|
| 50 completed games | `games_finished_total` on the metrics endpoint |
| No rule bugs | The arbiter suite, plus every finished game importing cleanly into Lichess. Lichess rejects illegal PGNs, so a successful import is an independent legality check on every real game played |
| Drag reliability on iOS and Android | The device matrix above, plus `miniapp_move_failures_total` staying under 1 % of `moves_total` |

The Lichess import check is worth stating plainly because it is the strongest guarantee here: the
alpha runs an independent chess engine over every game it produces, and a rule bug that the unit
tests missed shows up as a failed import rather than as a player's complaint.

## Practice

**A failing test is never a flake until proven.** The one flake this project has had was real: an
end-to-end test used network emulation that did not close an already-open stream, so it passed only
when the browser happened to drop the connection. It was fixed by making the drop deterministic,
not by adding a retry. If a test fails intermittently, reproduce it with `--repeat-each=6` before
calling it anything.

**Telegram versions are checked in every Mini App test.** The fake Telegram client
(`test/support/fakeWebApp.ts`) behaves like the real `telegram-web-app.js`: every method exists on
every version, and below its minimum version a method warns and does nothing, or throws, as the real
script does. It records each such use, and a global hook (and the e2e `page` fixture) fails the test
if the app made one. So a fallback test asserts only the fallback (the in-page sheet, the plain link);
that nothing unsupported was called is checked for it. Use `allowUnsupported(name)` only when a test
means to exercise an ungated path, and say why.

**A test that cannot fail is a bug.** When fixing or writing one, break the behaviour in `src` for a
moment and watch it go red.

**New features arrive with tests in the same commit.** Every plan in this repository was executed
test-first, and the fix passes after each review added a test alongside each fix. Keeping that
means a reviewer can tell what a change is supposed to do from its test.

**Before pushing a `v*` tag:** all pull-request gates green on `main`, the end-to-end workflow green
including the image smoke test, the device matrix run on at least iPhone and Android, and the
metrics above checked on staging.

**Coverage numbers are not collected.** The suite is organised around behaviour the spec names
rather than lines reached, and a percentage target would mostly reward testing the easy parts. If
that changes, add `@vitest/coverage-v8` and set a floor per package rather than one global number.
