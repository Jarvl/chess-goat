import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_FEN } from '@group-chess/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate';
import { scratchDatabase, type ScratchDatabase } from '../helpers/db';

const REAL_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TAG = '0011_conditional_premoves';

let tempDir: string;
let database: ScratchDatabase;
let scratch: postgres.Sql;
let scratchUrl: string;

type Journal = { entries: { tag: string }[] };

/**
 * The real migrations up to, not including, 0011: the database a release before it has. Later
 * migrations are cut too, so the test keeps meaning that once they exist.
 */
function migrationsBefore0011(): string {
  const folder = join(tempDir, 'before');
  cpSync(REAL_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const at = journal.entries.findIndex((entry) => entry.tag === TAG);
  if (at < 0) throw new Error(`no ${TAG} in the journal`);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'group-chess-0011-'));
  database = await scratchDatabase('migration_0011');
  ({ sql: scratch, url: scratchUrl } = database);
});

afterAll(async () => {
  await database.drop();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migration 0011: conditional premoves', () => {
  it('empties queued chains, leaves the old column in place and adds the tree columns', async () => {
    await runMigrations(scratchUrl, { migrationsFolder: migrationsBefore0011() });
    const [white] = await scratch<{ id: number }[]>`
      insert into users (first_name) values ('Alice') returning id`;
    const [black] = await scratch<{ id: number }[]>`
      insert into users (first_name) values ('Bob') returning id`;
    const [group] = await scratch<{ id: number }[]>`
      insert into groups (public_id, telegram_chat_id, title, type)
      values ('g0011', -1000011, 'Group', 'supergroup') returning id`;
    const game = (publicId: string, premoves: string[]) => scratch`
      insert into games (public_id, group_id, white_id, black_id, rated, fen, premoves)
      values (${publicId}, ${group!.id}, ${white!.id}, ${black!.id}, true, ${INITIAL_FEN},
        ${premoves}::text[])`;
    await game('chained', ['e2e4', 'g1f3']);
    await game('unchained', []);

    await runMigrations(scratchUrl);

    const rows = await scratch<
      { public_id: string; premoves: string[]; premove_tree: Buffer; premove_tree_ply: number }[]
    >`select public_id, premoves, premove_tree, premove_tree_ply from games order by public_id`;
    expect(
      rows.map((row) => [
        row.public_id,
        row.premoves,
        row.premove_tree.length,
        row.premove_tree_ply,
      ]),
    ).toEqual([
      ['chained', [], 0, 0],
      ['unchained', [], 0, 0],
    ]);
    const columns = await scratch<{ name: string; type: string; nullable: string }[]>`
      select column_name as name, data_type as type, is_nullable as nullable
      from information_schema.columns
      where table_name = 'games' and column_name like 'premove%' order by column_name`;
    expect(columns).toEqual([
      { name: 'premove_tree', type: 'bytea', nullable: 'NO' },
      { name: 'premove_tree_ply', type: 'integer', nullable: 'NO' },
      { name: 'premoves', type: 'ARRAY', nullable: 'NO' },
    ]);
  });
});
