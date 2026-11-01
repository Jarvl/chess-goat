# Parallel Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every worktree gets its own test databases and every e2e run its own ports, with no
per-session setup, and `pnpm test` never silently skips the integration suite.

**Architecture:** One plain-JS naming module (`scripts/test-database-name.mjs`) derives database
names from the worktree root; a server test helper (`apps/server/test/helpers/testDatabase.ts`) turns
them into URLs and creates and migrates the database with the existing
`runMigrations(url, { resetOnMismatch: true })`. Every test path (vitest global setup, `openTestDb`,
`scratchDatabase`, `testConfig`, the e2e harness) goes through it. The Playwright config picks free
ports at load and pins them in `process.env`.

**Tech Stack:** TypeScript, Vitest 5, Playwright, postgres.js, drizzle migrator, bash.

**Spec:** `docs/superpowers/specs/2026-11-01-parallel-test-isolation-design.md`

## Global Constraints

- Reuse `runMigrations(url, { resetOnMismatch: true })` from `apps/server/src/db/migrate.ts`; write no new mismatch logic.
- Default server when `TEST_DATABASE_URL` is unset: `postgres://postgres@127.0.0.1:54329/postgres`.
- `TEST_DATABASE_URL` chooses only the server and credentials; its database path is the admin connection, never the test database.
- Database names: only `[a-z0-9_]`, at most 63 bytes.
- Error messages show host and port only, never a password or full URL.
- No retries, no weakened tests. Each new test must be seen to fail before its code exists (`docs/testing.md`).
- Run commands from the repository root. `scripts/local-postgres.sh start` must be running for integration and e2e runs.
- `pnpm lint && pnpm format:check && pnpm typecheck` clean before each commit.

## Review Focus

1. **Two worktrees whose folders share a name** (a re-created worktree at a new path, or two clones called `chess-goat`) must get different databases. Covered in Task 1 by the hash test.
2. **An old shell export `TEST_DATABASE_URL=…/chess_goat_test` on a fresh cluster**, where that database no longer exists: the run still works by falling back to the `postgres` database. Covered in Task 2.
3. **Postgres not running:** the run fails at once with host:port and `scripts/local-postgres.sh start`, and the message carries no password. Covered in Task 2.
4. **Integration and e2e global setup creating the same database at the same moment:** the loser treats SQLSTATE `42P04` as success. Covered in Task 2 by the concurrent-call test.
5. **Another worktree's harness already on 4180/4181**, which is the case on this machine today: `pnpm e2e` starts its own server on other ports. Covered in Task 4's verification step.

---

### Task 1: Worktree database naming

**Files:**
- Create: `scripts/test-database-name.mjs`, `scripts/test-database-name.d.mts` (same pattern as `fetch-fonts.mjs` and `fetch-fonts.d.mts`)
- Test: `apps/server/test/unit/testDatabaseName.test.ts`

**Interfaces:**
- Produces:
  - `REPO_ROOT: string`, the absolute repository root, resolved from the module's own location.
  - `worktreeKey(root: string): string` → `<slug>_<hash>`. The slug is `basename(root)` lowercased, with each run of `[^a-z0-9]` replaced by `_`, cut to its **last** 16 characters (the distinctive end of `bridge-cse_01DAqcv…`), with `_` trimmed from both ends; `root` if empty. The hash is the first 6 hex characters of sha256 over `path.resolve(root)`.
  - `testDatabaseName(root: string, kind: 'test' | 'e2e' = 'test'): string` → `chess_goat_test_<key>`, plus `_e2e` for e2e.
  - `scratchDatabaseName(root: string, name: string, pid: number): string` → `chess_goat_scratch_<key>_<pid>_<name>`, cut to 63 characters.
  - CLI: `node scripts/test-database-name.mjs key <root>` prints `worktreeKey(root)` and a newline (used by `prune` in Task 4).

- [ ] **Step 1: Write the failing tests** in `testDatabaseName.test.ts`, importing from `../../../../scripts/test-database-name.mjs`:

```ts
const WT = '/home/x/chess-goat/.claude/worktrees/bridge-cse_01DAqcvHKEGKk8jaxWGSw1sA';
it('names a worktree database from the end of its folder name plus a path hash', () => {
  expect(testDatabaseName(WT)).toMatch(/^chess_goat_test_kegkk8jaxwgsw1sa_[0-9a-f]{6}$/);
  expect(testDatabaseName(WT, 'e2e')).toBe(`${testDatabaseName(WT)}_e2e`);
});
it('gives folders with the same name at different paths different databases', () => {
  expect(testDatabaseName('/a/chess-goat')).not.toBe(testDatabaseName('/b/chess-goat'));
});
it('is stable for one root', () => {
  expect(testDatabaseName(WT)).toBe(testDatabaseName(`${WT}/`));
});
it.each([WT, '/x/' + 'Ü-'.repeat(80), '/'])('stays a valid identifier for %s', (root) => {
  for (const name of [testDatabaseName(root, 'e2e'), scratchDatabaseName(root, 'migration_0011', 4_194_304)]) {
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  }
});
it('puts the worktree key in scratch database names', () => {
  expect(scratchDatabaseName(WT, 'migrate', 42)).toBe(`chess_goat_scratch_${worktreeKey(WT)}_42_migrate`);
});
```

- [ ] **Step 2: Run it.** `pnpm vitest run apps/server/test/unit/testDatabaseName.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `scripts/test-database-name.mjs` and its `.d.mts` to the interfaces above, using `node:crypto`, `node:path` and `node:url`.
- [ ] **Step 4: Run it.** Same command; expected PASS. Also run `node scripts/test-database-name.mjs key "$PWD"`, which should print one key.
- [ ] **Step 5: Commit.** `git commit -m "Name test databases after the worktree"`

### Task 2: Create and migrate the worktree database

**Files:**
- Create: `apps/server/test/helpers/testDatabase.ts`
- Test: `apps/server/test/integration/testDatabase.test.ts`

**Interfaces:**
- Consumes: `REPO_ROOT` and `testDatabaseName` (Task 1); `runMigrations` (`src/db/migrate.ts`).
- Produces:
  - `type TestDatabaseOptions = { root?: string; server?: string }`. `root` defaults to `REPO_ROOT`; `server` defaults to `process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres'`.
  - `testDatabaseUrl(kind?: 'test' | 'e2e', options?: TestDatabaseOptions): string`. Synchronous: the server URL with its pathname replaced by `/${testDatabaseName(root, kind)}`.
  - `ensureTestDatabase(kind?: 'test' | 'e2e', options?: TestDatabaseOptions): Promise<string>`. Connects to the server URL as admin. On SQLSTATE `3D000`, retries once with pathname `/postgres`. Runs `create database`, ignoring `42P04`. Then `runMigrations(url, { resetOnMismatch: true })` and returns the URL. If the connection fails (`ECONNREFUSED` or similar), throws `Error("No PostgreSQL at <host>:<port> for the tests. Start one with scripts/local-postgres.sh start, or set TEST_DATABASE_URL to a server.")`.

- [ ] **Step 1: Write the failing tests.** Each test uses a unique root, `` `/tmp/isolation-${process.pid}-<case>` ``, and drops its database in `afterEach` with `drop database if exists … with (force)` over an admin connection to `testDatabaseUrl()`.
  - `creates and migrates a database for a new worktree`: `await ensureTestDatabase('test', { root })` resolves to `testDatabaseUrl('test', { root })`, and a `users` table exists there.
  - `survives two setups creating the same database at once`: `Promise.all` of two `ensureTestDatabase('e2e', { root })` calls both resolve.
  - `rebuilds a database another branch migrated`: after a first ensure, run `create table marker (id int)` and `insert into drizzle.__drizzle_migrations (hash, created_at) values ('not-this-build', 0)`. Ensure again: `marker` is gone (`to_regclass('marker') is null`) and no row has hash `not-this-build`.
  - `falls back to the postgres database when the named one is missing`: `server` is `testDatabaseUrl()` with pathname `/no_such_db_${process.pid}`; ensure resolves.
  - `fails with the address and the fix when no server answers`: `server: 'postgres://postgres:hunter2@127.0.0.1:1/postgres'` rejects. The message matches `/127\.0\.0\.1:1/` and `/scripts\/local-postgres\.sh start/`, and does not contain `hunter2`.
- [ ] **Step 2: Run it.** `pnpm vitest run apps/server/test/integration/testDatabase.test.ts` (with `TEST_DATABASE_URL` exported, as today). Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `testDatabase.ts`. Create the admin connection with `postgres(url, { max: 1, onnotice: () => undefined })` and close it in `finally`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Create and migrate each worktree's test database on demand"`

### Task 3: Route the integration suite through it, and stop skipping silently

**Files:**
- Modify: `apps/server/test/helpers/globalSetup.ts`, `apps/server/test/helpers/db.ts` (`openTestDb`, `scratchDatabase`), `apps/server/test/helpers/config.ts:10`, `apps/server/test/integration/db.test.ts:58`, `apps/server/test/integration/stats-views.test.ts:68`, `apps/server/vitest.config.ts`, `package.json` (scripts)

**Interfaces:**
- Consumes: `testDatabaseUrl`, `ensureTestDatabase` (Task 2); `scratchDatabaseName`, `REPO_ROOT` (Task 1).
- Produces:
  - `openTestDb(url?: string)`, defaulting to `testDatabaseUrl()`.
  - `testConfig()` defaults `DATABASE_URL` to `testDatabaseUrl()`.
  - `scratchDatabase(name)` connects as admin to `testDatabaseUrl()` and names its database `scratchDatabaseName(REPO_ROOT, name, process.pid)`.
  - Root script `"test:unit": "TEST_UNIT_ONLY=1 vitest run"`.

- [ ] **Step 1: Switch the callers.** `globalSetup` becomes `await ensureTestDatabase('test')`. In `db.test.ts` and `stats-views.test.ts`, replace `process.env.TEST_DATABASE_URL!` with `testDatabaseUrl()`; dropping a role works from any database. After this step, `grep -rn TEST_DATABASE_URL apps/server/test` should match only `testDatabase.ts`.
- [ ] **Step 2: Change `apps/server/vitest.config.ts`.** Remove `hasDatabase` and its warning. Add `const unitOnly = process.env.TEST_UNIT_ONLY === '1'`, which selects `test/unit/**` and only the fonts global setup. Otherwise `test/**/*.test.ts` runs with both global setups. Add the `test:unit` root script.
- [ ] **Step 3: Check that a missing server fails loudly.** `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:1/postgres pnpm vitest run --project server` should exit non-zero with the Task 2 message. `pnpm test:unit` should exit 0 and run no `test/integration` file.
- [ ] **Step 4: Check isolation.** `unset TEST_DATABASE_URL; pnpm test` should pass in full, and `psql -h 127.0.0.1 -p 54329 -U postgres -lqt | cut -d'|' -f1 | grep chess_goat_test_` should show this worktree's database. `chess_goat_test` is untouched.
- [ ] **Step 5: Commit.** `git commit -m "Integration tests use the worktree's database and fail when none is reachable"`

### Task 4: E2E on its own database and ports

**Files:**
- Modify: `apps/server/test/e2e/harness.ts:22-23,105-109`, `apps/miniapp/playwright.config.ts`, `apps/miniapp/e2e/support.ts:24,112`

**Interfaces:**
- Consumes: `ensureTestDatabase('e2e')`, `openTestDb(url)`.
- Produces: `E2E_APP_PORT` and `E2E_HARNESS_PORT` are always set in the environment of the Playwright workers and of the harness.

- [ ] **Step 1: Harness.** Replace the `TEST_DATABASE_URL` read and `runMigrations` call with `const url = await ensureTestDatabase('e2e')`, and use `openTestDb(url)`. Drop the `?? 4180` / `?? 4181` defaults: throw if either port variable is missing.
- [ ] **Step 2: Playwright config.** Before `defineConfig`, if either variable is unset, pick two free ports. Hold both listeners (port 0 on `127.0.0.1`) open at once, then close them, so the two ports can't be the same. Assign them with `process.env.E2E_APP_PORT ??= …`. Build `baseURL` and `webServer.url` from them. Set `reuseExistingServer: false`. The package is ESM, so top-level `await` works; workers re-run the config but find the variables already set.
- [ ] **Step 3: support.ts.** `HARNESS` and the `/metrics` URL read `process.env.E2E_HARNESS_PORT` and `E2E_APP_PORT`; throw if they are unset.
- [ ] **Step 4: Verify against a live collision.** Start another harness on 4180/4181 first, or use the one another worktree is already running. Then run `pnpm fonts && pnpm e2e`. Expected: all specs pass, the harness log line shows ports other than 4180/4181, and `chess_goat_test_<key>_e2e` exists.
- [ ] **Step 5: Commit.** `git commit -m "E2E runs on free ports and the worktree's own database, never reusing a server"`

### Task 5: Prune, the local script, and the docs

**Files:**
- Modify: `scripts/local-postgres.sh`, `docs/testing.md`, `README.md` (Checks block)

**Interfaces:**
- Consumes: `node scripts/test-database-name.mjs key <root>` (Task 1).

- [ ] **Step 1: Change `start`.** `DBS="chess_goat"` only. Print `export DATABASE_URL=…`, then a comment line saying tests need no export (`TEST_DATABASE_URL` is optional and picks the server).
- [ ] **Step 2: Add `prune`.** Read worktree paths from `git -C "$(dirname "$0")/.." worktree list --porcelain` (lines starting `worktree `). Keep a path only if the folder exists, and take its key with the CLI. List databases with `datname like 'chess_goat_test_%' or datname like 'chess_goat_scratch_%'`. Drop each one (`drop database … with (force)`) whose name contains no live key, and echo `dropped <name>`. Never consider `chess_goat` or `postgres`; the `like` patterns already exclude them. Update the usage line to `start|stop|prune`.
- [ ] **Step 3: Verify prune.** Run `psql … -c 'create database chess_goat_test_gone_abcdef'`, then `scripts/local-postgres.sh prune`. Expected: it prints `dropped chess_goat_test_gone_abcdef`, and this worktree's `chess_goat_test_<key>` and `_e2e` still exist.
- [ ] **Step 4: Docs.**
  - In `docs/testing.md`, replace the "Integration tests need `TEST_DATABASE_URL`…" sentences and the "Local setup is one command" paragraph with how databases and ports are chosen.
  - Add a "Running alongside other sessions" subsection: no setup per worktree; one Postgres per machine; `TEST_DATABASE_URL` only picks the server; `prune`.
  - Add `pnpm test:unit` to the "What runs where" table.
  - In `README.md`, drop the `export TEST_DATABASE_URL` line and the "only unit tests run" comment, and mention `scripts/local-postgres.sh start` once.
- [ ] **Step 5: Final check.** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm e2e`, with `TEST_DATABASE_URL` unset. Everything should pass.
- [ ] **Step 6: Commit.** `git commit -m "Prune stale test databases; document parallel test runs"`
