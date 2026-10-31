import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { LocalBus } from '../../src/bus/bus';
import { createDb, type Db, type Tx } from '../../src/db/client';
import type { Deps } from '../../src/domain/deps';
import { createLogger } from '../../src/logger';

export function openTestDb(): ReturnType<typeof createDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  return createDb(url, { max: 6 });
}

export async function truncateAll(db: Db): Promise<void> {
  // `user_photos` and `user_flair` are left to the cascade from `users`: listing either first would
  // lock it before `users`, the reverse of the order the photo and award jobs take, and the truncate
  // could deadlock with one. `flair_backfills` is written by the backfill job, which locks no rows,
  // and sits before `users` with the rest.
  await db.execute(
    sql`truncate table tips, admin_actions, shares, board_images, moves, dm_messages, games, challenges, ratings, group_members, jobs, telegram_updates, groups, flair_backfills, users restart identity cascade`,
  );
  // The engine user is created by migration 0002, not by any test — truncating `users`
  // removes it, so put it back to keep the helper's contract "empty database, plus the
  // engine user that migrations guarantee".
  await db.execute(
    sql`insert into users (first_name, is_engine, dm_allowed) values ('Stockfish', true, false) on conflict do nothing`,
  );
}

export function testDeps(db: Db): Deps {
  return { db, bus: new LocalBus(), log: createLogger('fatal') };
}

/**
 * Runs `work` in a transaction and leaves the transaction open, holding every lock `work` took,
 * until `commit()` is called: so a test can meet those locks from another session.
 */
export async function holdOpen(
  db: Db,
  work: (tx: Tx) => Promise<unknown>,
): Promise<{ commit: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let worked!: () => void;
  const hasWorked = new Promise<void>((resolve) => (worked = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    worked();
    await released;
  });
  await Promise.race([hasWorked, done]);
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}

/** Runs `work` in a transaction that fails, rather than waits, when a lock keeps it over a second. */
export function withoutWaiting(db: Db, work: (tx: Tx) => Promise<unknown>): Promise<void> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '1s'`);
    await work(tx);
  });
}

/**
 * Resolves once exactly `count` sessions of this database are waiting for a lock, optionally only
 * those running a statement like `queryLike`. (`pg_stat_activity` covers the whole server, and
 * other test databases share it.)
 */
export async function waitForLockWaiters(db: Db, count: number, queryLike?: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const [row] = await db.execute(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        and (${queryLike ?? null}::text is null or query ilike ${queryLike ?? null})`);
    if (row?.waiting === count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${count} session(s) never came to wait for a lock`);
}

export type ScratchDatabase = { url: string; sql: postgres.Sql; drop(): Promise<void> };

/** A new, empty database beside the test one, for a test that migrates from nothing. */
export async function scratchDatabase(name: string): Promise<ScratchDatabase> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  const admin = postgres(base, { max: 1, onnotice: () => undefined });
  const database = `chess_goat_${name}_${process.pid}`;
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  await admin.unsafe(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  const scratch = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  return {
    url: url.toString(),
    sql: scratch,
    drop: async () => {
      await scratch.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}
