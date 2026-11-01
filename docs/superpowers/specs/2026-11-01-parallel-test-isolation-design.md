# Parallel test isolation for worktrees and concurrent sessions

## Why

Several AI sessions work on this repository at once, each in its own git worktree under
`.claude/worktrees/`, all on one machine sharing one PostgreSQL server. The test setup assumes one
checkout at a time, and all three of the following have caused real trouble:

1. **E2E tests the wrong code.** `apps/miniapp/playwright.config.ts` hard-codes ports 4180/4181 and
   sets `reuseExistingServer: !process.env.CI`. If another worktree's harness is already listening,
   `pnpm e2e` silently runs against that worktree's server and built Mini App. (Observed while writing
   this: a harness from another worktree held both ports.)
2. **Integration runs wipe each other.** Every session uses the one `chess_goat_test` database, and
   `truncateAll` empties every table between cases. Past plans worked around it by hand-creating
   per-worktree databases under four different conventions (`_flair`, `_share`, `_moveconfirm`,
   Docker on 5432 vs `scripts/local-postgres.sh` on 54329).
3. **Missing setup passes silently.** Without `TEST_DATABASE_URL`, `apps/server/vitest.config.ts`
   narrows to unit tests and only warns, so an agent can report "all green" without the integration
   suite having run.

## Goals

- Any session in any worktree runs `pnpm test` or `pnpm e2e` with no per-session setup, and its run
  cannot read, write or reuse another worktree's database, server or built app.
- This holds however tests are invoked: `pnpm test`, `pnpm --filter @chess-goat/server exec vitest
  run test/integration/x.test.ts`, `pnpm vitest run <file>` from the root, or
  `pnpm --filter @chess-goat/miniapp exec playwright test e2e/x.spec.ts`. Plans in this repo run
  single files these ways constantly.
- A run either executes the integration suite or fails loudly. Skipping it is an explicit choice.
- CI keeps working with its existing Postgres service.

## Non-goals

- Two concurrent test runs inside the **same** worktree. The user confirmed runs are one at a time
  per worktree, since a run concerns that worktree's changes. (E2E and integration in the same
  worktree are still separated; see below.)
- Starting PostgreSQL automatically. Tests expect a server to be up.
- Parallelising tests within a run (`fileParallelism: false` and `workers: 1` stay as they are).
- Isolating the dev server (`pnpm dev:server`, `DATABASE_URL`, ports 3000/5173).

## Anti-goals

- Anything that only works through a wrapper script, so a direct `vitest`/`playwright` call quietly
  falls back to shared state. That is the failure we are removing.
- A manual per-worktree step (a `.env.test.local` to write, a database to create by hand).
- Weakening tests or adding retries to hide collisions.

## Constraints

- One PostgreSQL server per machine, normally `scripts/local-postgres.sh` on `127.0.0.1:54329`
  (trust auth, user `postgres`). CI provides its own via `TEST_DATABASE_URL`.
- Postgres identifiers are at most 63 bytes; worktree folder names look like
  `bridge-cse_01DAqcvHKEGKk8jaxWGSw1sA`.
- Playwright re-evaluates its config file in each worker process, so anything random chosen at
  config load must be pinned in `process.env` by the main process so workers inherit the same value.
- Reuse the existing migration-mismatch reset: `runMigrations(url, { resetOnMismatch: true })` in
  `apps/server/src/db/migrate.ts` (the code behind staging's `DATABASE_RESET_ON_MISMATCH`). It
  already compares applied migrations to the build's by hash under an advisory lock, wipes the
  schema on mismatch and migrates. No new mismatch logic is to be written.

## Approaches considered

- **A. Isolation inside the test configs and helpers (chosen).** A small helper derives this
  worktree's database name and ensures the database exists; the server's vitest global setup,
  `openTestDb`, `scratchDatabase` and the e2e harness all go through it. The Playwright config picks
  free ports at load and passes them on. Works for every invocation path. Costs a little logic in
  config files.
- **B. A wrapper script** (`node scripts/with-test-env.mjs vitest run`) that sets env and execs the
  runner. Simpler configs, but any direct `vitest`/`playwright` call bypasses it and returns to
  shared state. Rejected: direct calls are how agents run single files here.
- **C. A per-worktree `.env.test.local`.** Goes stale, needs a manual step. Dropped early.

The user picked A.

## Design

### Database per worktree

- A helper (suggested home: `apps/server/test/helpers/testDatabase.ts`) resolves the test database
  URL:
  - **Server:** `TEST_DATABASE_URL` if set, otherwise `postgres://postgres@127.0.0.1:54329/postgres`.
    `TEST_DATABASE_URL` now only chooses the server and credentials; its database path is used as
    the admin connection for `create database`, not as the test database.
  - **Name:** derived from the worktree root (`git rev-parse --show-toplevel`, or walk up from the
    helper's file to the repo root, builder's choice). Form: `chess_goat_test_<slug>`, where the slug
    is the folder name lowercased and reduced to `[a-z0-9_]`, truncated, plus a short hash of the
    full root path so two folders with the same name never collide, all within 63 bytes. The main
    checkout gets a name by the same rule (no special case).
  - **E2E** uses the same name with an `_e2e` suffix, because the harness also truncates tables and
    an integration run and an e2e run in one worktree should not meet.
- **Create if missing**, then `runMigrations(url, { resetOnMismatch: true })`. Two processes may race
  to create the same database (vitest global setup and the e2e harness of one worktree at once):
  treat "database already exists" (SQLSTATE `42P04`) as success.
- Callers to switch over: `test/helpers/globalSetup.ts`, `openTestDb` and `scratchDatabase` in
  `test/helpers/db.ts`, and `test/e2e/harness.ts`. `scratchDatabase` keeps making its own databases
  beside the worktree's; its names should include the worktree slug as well as the pid so `prune`
  can attribute them. Grep `apps/server/test` for any other direct `process.env.TEST_DATABASE_URL`
  read and route it through the helper. Known ones: `test/helpers/config.ts` (passes it as
  `DATABASE_URL` to `testConfig`; must switch, or integration tests built on `testConfig` hit the
  admin database), `integration/db.test.ts`, and `integration/stats-views.test.ts` (drops its role).
- **Old exports on a fresh cluster:** if the admin database named in `TEST_DATABASE_URL` does not
  exist (SQLSTATE `3D000`, e.g. an old `…/chess_goat_test` export after `start` stops creating it),
  retry the admin connection against the `postgres` database on the same server.
- **Unreachable server:** fail the run in global setup with a message naming the URL tried and
  `scripts/local-postgres.sh start`.

### Loud failure instead of a silent skip

- `apps/server/vitest.config.ts` always includes integration tests and the database global setup.
  The `hasDatabase` branch and its warning go away.
- New root script `pnpm test:unit` runs the unit tests only: shared, miniapp and the server's
  `test/unit/**`, without the database global setup. How to express it (a separate vitest project,
  an env flag the server config reads, CLI project/dir filters) is the builder's choice, as long as
  plain `pnpm test` never skips integration.

### E2E ports and no server reuse

- `apps/miniapp/playwright.config.ts`: if `E2E_APP_PORT`/`E2E_HARNESS_PORT` are not set, pick two
  free ports (bind to port 0, read, close) and write them to `process.env` before building the
  config, so workers and the `webServer` child inherit them. `baseURL`, `webServer.url` and the
  harness command derive from them.
- `reuseExistingServer: false` always.
- `apps/miniapp/e2e/support.ts` stops hard-coding `4180`/`4181` (the `HARNESS` constant and the
  `/metrics` fetch) and reads the same env vars. The harness already reads them.

### Cleanup

- `scripts/local-postgres.sh prune` lists databases matching `chess_goat_test_%` (and scratch
  databases carrying a slug), and drops those whose worktree no longer exists in
  `git worktree list --porcelain` from the main repository. Run by hand; prints what it dropped. It
  must recompute names with the same slug rule as the TypeScript helper (shared logic or a
  documented duplicate, builder's choice) and must never drop `chess_goat` or `postgres`.

### CI

- Both workflows keep their Postgres service and `TEST_DATABASE_URL`. With this design that URL is
  only the server; the test database gets a derived name and is created on the fly. No other
  workflow change expected. Builder confirms the CI checkout path yields a valid name.

### Docs

- `docs/testing.md`: replace the `TEST_DATABASE_URL` paragraph with how databases and ports are
  chosen, a short "Running alongside other sessions" section (no per-worktree setup; one Postgres
  per machine; `prune`), and `pnpm test:unit`. Update the test counts only if they change.
- `README.md` Checks block: drop the `export TEST_DATABASE_URL` line and the "only unit tests run"
  comment; mention `scripts/local-postgres.sh start` once.
- `scripts/local-postgres.sh start`: stop printing `TEST_DATABASE_URL` as a must-export (it is
  optional now); keep creating `chess_goat` for development. It no longer needs to create
  `chess_goat_test`.

## Left to the builder

- Exact helper names, file locations and the slug/hash format within the rules above.
- How `pnpm test:unit` is wired.
- Whether `prune` shares the naming logic with TypeScript or reimplements it in shell.
- Tests for the helper (name derivation, 63-byte limit, collision hash, `42P04` handling) in
  `apps/server/test/unit` or `integration` as fits. Per `docs/testing.md`, each new test must be
  seen to fail first.

## Calls made by the designer (not by the user)

- Default server `127.0.0.1:54329`, from the existing local script.
- `TEST_DATABASE_URL` keeps its name but changes meaning to "which server", so old exports in
  shells keep working and still isolate.
- A separate `_e2e` database within each worktree.
- `prune` is manual, not automatic.
- Fall back to the `postgres` admin database when the one in `TEST_DATABASE_URL` is missing.
