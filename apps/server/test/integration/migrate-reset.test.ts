import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate';
import { scratchDatabase, type ScratchDatabase } from '../helpers/db';

const REAL_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

let database: ScratchDatabase;
let scratch: postgres.Sql;
let scratchUrl: string;
let tempDir: string;

type Journal = {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

/** A copy of the real migrations plus `extra`, each one `create table <tag>` at timestamp `when`. */
function migrationsFolder(name: string, extra: { tag: string; when: number }[] = []): string {
  const folder = join(tempDir, name);
  cpSync(REAL_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  for (const { tag, when } of extra) {
    writeFileSync(join(folder, `${tag}.sql`), `create table "${tag}" (id integer);`);
    journal.entries.push({
      idx: journal.entries.length,
      version: '7',
      when,
      tag,
      breakpoints: true,
    });
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const lastRealWhen = (
  JSON.parse(readFileSync(join(REAL_FOLDER, 'meta', '_journal.json'), 'utf8')) as Journal
).entries.at(-1)!.when;
const branchA = { tag: '9990_branch_a', when: lastRealWhen + 2_000 };
const branchB = { tag: '9991_branch_b', when: lastRealWhen + 1_000 };
const branchC = { tag: '9992_branch_c', when: lastRealWhen + 3_000 };

async function tables(): Promise<string[]> {
  const rows = await scratch<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public'`;
  return rows.map((row) => row.name);
}

async function markerSurvives(): Promise<boolean> {
  return (await tables()).includes('reset_marker');
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'group-chess-migrations-'));
});

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

beforeEach(async () => {
  database = await scratchDatabase('migrate');
  ({ sql: scratch, url: scratchUrl } = database);
});

afterEach(() => database.drop());

/** Migrates with `folder`, then leaves a table that only survives if the next boot keeps the data. */
async function deploy(folder: string): Promise<void> {
  await runMigrations(scratchUrl, { migrationsFolder: folder });
  await scratch`create table reset_marker (id integer)`;
}

describe('runMigrations with resetOnMismatch', () => {
  it('migrates an empty database without reporting a reset', async () => {
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: migrationsFolder('main'),
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: false });
    expect(await tables()).toContain('games');
  });

  it('keeps the data when the build has exactly the applied migrations', async () => {
    const main = migrationsFolder('main');
    await deploy(main);
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: main,
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: false });
    expect(await markerSurvives()).toBe(true);
  });

  it('keeps the data and migrates forward when the build only adds migrations', async () => {
    await deploy(migrationsFolder('main'));
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: migrationsFolder('branch-a', [branchA]),
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: false });
    expect(await markerSurvives()).toBe(true);
    expect(await tables()).toContain(branchA.tag);
  });

  it('resets when the database has a migration the build does not', async () => {
    await deploy(migrationsFolder('branch-a', [branchA]));
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: migrationsFolder('main'),
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: true });
    expect(await markerSurvives()).toBe(false);
    expect(await tables()).not.toContain(branchA.tag);
    expect(await tables()).toContain('games');
  });

  it('resets and applies a migration older than the last applied one, which drizzle alone skips', async () => {
    await deploy(migrationsFolder('branch-a', [branchA]));
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: migrationsFolder('branch-b', [branchB]),
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: true });
    expect(await tables()).toContain(branchB.tag);
    expect(await tables()).not.toContain(branchA.tag);
  });

  it('resets when a newer migration would otherwise stack on another branch’s', async () => {
    await deploy(migrationsFolder('branch-a', [branchA]));
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: migrationsFolder('branch-c', [branchC]),
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: true });
    expect(await tables()).toContain(branchC.tag);
    expect(await tables()).not.toContain(branchA.tag);
  });

  it('resets when an applied migration’s contents changed', async () => {
    await deploy(migrationsFolder('branch-a', [branchA]));
    const edited = migrationsFolder('branch-a-edited', [branchA]);
    writeFileSync(join(edited, `${branchA.tag}.sql`), `create table "${branchA.tag}" (id bigint);`);
    const result = await runMigrations(scratchUrl, {
      migrationsFolder: edited,
      resetOnMismatch: true,
    });
    expect(result).toEqual({ reset: true });
    expect(await markerSurvives()).toBe(false);
  });

  it('never resets without the flag, even on a mismatch', async () => {
    await deploy(migrationsFolder('branch-a', [branchA]));
    const result = await runMigrations(scratchUrl, { migrationsFolder: migrationsFolder('main') });
    expect(result).toEqual({ reset: false });
    expect(await markerSurvives()).toBe(true);
    expect(await tables()).toContain(branchA.tag);
  });
});

describe('the migrations', () => {
  it('create exactly one engine user, Stockfish, with no Telegram id and no DMs', async () => {
    await runMigrations(scratchUrl, { migrationsFolder: migrationsFolder('main') });
    const rows = await scratch<
      { first_name: string; telegram_user_id: number | null; dm_allowed: boolean }[]
    >`
      select first_name, telegram_user_id, dm_allowed from users where is_engine`;
    expect(rows).toEqual([{ first_name: 'Stockfish', telegram_user_id: null, dm_allowed: false }]);
  });
});
