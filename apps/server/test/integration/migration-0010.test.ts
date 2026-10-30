import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema';
import { openTestDb, truncateAll } from '../helpers/db';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const migration = readFileSync(
  new URL('../../drizzle/0010_legacy_dm_job_keys.sql', import.meta.url),
  'utf8',
);
const run = async () => {
  for (const statement of migration.split('--> statement-breakpoint'))
    if (statement.trim()) await db.execute(sql.raw(statement));
};

describe('migration 0010: legacy send_dm dedup keys', () => {
  it('rewrites pending per-ply keys to one key per player and game, keeping the newest', async () => {
    await db.insert(jobs).values([
      { kind: 'send_dm', dedupKey: 'dm:7:g:abc:turn:3', payload: { n: 1 } },
      { kind: 'send_dm', dedupKey: 'dm:7:g:abc:reminder:3', payload: { n: 2 } },
      { kind: 'send_dm', dedupKey: 'dm:8:g:abc:turn:4', payload: { n: 3 } },
      { kind: 'send_dm', dedupKey: 'dm:7:ch:xyz', payload: { n: 4 } },
      {
        kind: 'send_dm',
        dedupKey: 'dm:9:g:abc:turn:1',
        payload: { n: 5 },
        doneAt: new Date(),
      },
    ]);
    await run();
    await run();
    const rows = await db.select().from(jobs).orderBy(jobs.id);
    expect(rows.map((row) => [row.dedupKey, row.payload])).toEqual([
      ['dm:7:g:abc', { n: 2 }],
      ['dm:8:g:abc', { n: 3 }],
      ['dm:7:ch:xyz', { n: 4 }],
      ['dm:9:g:abc:turn:1', { n: 5 }],
    ]);
  });
});
