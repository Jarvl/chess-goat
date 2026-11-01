import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabaseName } from '../../../../scripts/test-database-name.mjs';
import { ensureTestDatabase, testDatabaseUrl } from '../helpers/testDatabase';

const created: string[] = [];

/** A worktree root no real checkout has, so each case gets databases of its own. */
function rootFor(name: string): string {
  const root = `/tmp/isolation-${process.pid}-${name}`;
  created.push(testDatabaseName(root), testDatabaseName(root, 'e2e'));
  return root;
}

afterEach(async () => {
  const server = new URL(testDatabaseUrl());
  server.pathname = '/postgres';
  const admin = postgres(server.toString(), { max: 1, onnotice: () => undefined });
  for (const database of created.splice(0)) {
    await admin.unsafe(`drop database if exists ${database} with (force)`);
  }
  await admin.end({ timeout: 5 });
});

async function inDatabase<T>(url: string, query: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    return await query(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('ensureTestDatabase', () => {
  it('creates and migrates a database for a new worktree', async () => {
    const root = rootFor('new');
    const url = await ensureTestDatabase('test', { root });
    expect(url).toBe(testDatabaseUrl('test', { root }));
    const [row] = await inDatabase(
      url,
      (sql) => sql`select to_regclass('users') is not null as ok`,
    );
    expect(row?.ok).toBe(true);
  });

  it('survives two setups creating the same database at once', async () => {
    const root = rootFor('race');
    await expect(
      Promise.all([ensureTestDatabase('e2e', { root }), ensureTestDatabase('e2e', { root })]),
    ).resolves.toHaveLength(2);
  });

  it('rebuilds a database another branch migrated', async () => {
    const root = rootFor('drift');
    const url = await ensureTestDatabase('test', { root });
    await inDatabase(url, async (sql) => {
      await sql`create table marker (id int)`;
      await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('not-this-build', 0)`;
    });
    await ensureTestDatabase('test', { root });
    const [row] = await inDatabase(
      url,
      (sql) => sql`
        select to_regclass('marker') is null as gone,
          not exists (select 1 from drizzle.__drizzle_migrations where hash = 'not-this-build') as forgotten`,
    );
    expect(row).toEqual({ gone: true, forgotten: true });
  });

  it('falls back to the postgres database when the named one is missing', async () => {
    const root = rootFor('fallback');
    const server = new URL(testDatabaseUrl());
    server.pathname = `/no_such_db_${process.pid}`;
    await expect(ensureTestDatabase('test', { root, server: server.toString() })).resolves.toBe(
      testDatabaseUrl('test', { root, server: server.toString() }),
    );
  });

  it('fails with the address and the fix when no server answers', async () => {
    const error = await ensureTestDatabase('test', {
      root: rootFor('down'),
      server: 'postgres://postgres:hunter2@127.0.0.1:1/postgres',
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/127\.0\.0\.1:1/);
    expect(error.message).toMatch(/scripts\/local-postgres\.sh start/);
    expect(error.message).not.toContain('hunter2');
  });
});
