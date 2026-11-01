import { INITIAL_FEN } from '@chess-goat/shared';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate';
import { scratchDatabase, type ScratchDatabase } from '../helpers/db';

const READER = `stats_reader_test_${process.pid}`;
const VIEWS = {
  users: ['id', 'created_at', 'last_seen_at', 'has_played', 'deleted'],
  groups: ['id', 'created_at', 'type', 'is_forum', 'bot_present'],
  games: [
    'id',
    'group_id',
    'white_id',
    'black_id',
    'started_at',
    'finished_at',
    'last_move_at',
    'status',
    'end_reason',
    'rated',
    'vs_engine',
    'ply_count',
    'voided',
    'counted',
  ],
  moves: ['game_id', 'ply', 'played_at'],
  shares: ['id', 'game_id', 'user_id', 'created_at'],
  challenges: ['id', 'group_id', 'created_at', 'resolved_at', 'status', 'rated'],
  tips: ['id', 'paid_at', 'stars', 'refunded'],
} as const;

let database: ScratchDatabase;
let scratch: postgres.Sql;
let scratchUrl: string;
let databaseName: string;
let roleCreated = false;

/** The runbook's grant statements in docs/operations.md, with the role and database adapted. Keep in sync. */
async function grantReader(): Promise<void> {
  await scratch.unsafe(`create role ${READER} nologin`);
  roleCreated = true;
  await scratch.unsafe(`grant connect on database ${databaseName} to ${READER}`);
  await scratch.unsafe(`grant usage on schema stats to ${READER}`);
  await scratch.unsafe(`grant select on all tables in schema stats to ${READER}`);
  await scratch.unsafe(
    `alter default privileges in schema stats grant select on tables to ${READER}`,
  );
  await scratch.unsafe(`revoke all on schema public from ${READER}`);
}

beforeAll(async () => {
  database = await scratchDatabase('stats_views');
  ({ sql: scratch, url: scratchUrl } = database);
  await runMigrations(scratchUrl);
  [{ name: databaseName }] = await scratch<{ name: string }[]>`select current_database() as name`;
  await grantReader();
});

afterAll(async () => {
  // Roles are cluster-wide: release what the role owns in the scratch database before dropping it.
  if (roleCreated) {
    await scratch.unsafe(`drop owned by ${READER}`);
  }
  await database.drop();
  if (roleCreated) {
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop role if exists ${READER}`);
    await admin.end({ timeout: 5 });
  }
});

async function seedUser(name: string): Promise<number> {
  const [row] = await scratch<{ id: number }[]>`
    insert into users (first_name) values (${name}) returning id`;
  return Number(row!.id);
}

async function engineId(): Promise<number> {
  const [row] = await scratch<{ id: number }[]>`select id from users where is_engine`;
  return Number(row!.id);
}

async function seedGroup(publicId: string, chat: number, botStatus = 'member'): Promise<number> {
  const [row] = await scratch<{ id: number }[]>`
    insert into groups (public_id, telegram_chat_id, title, type, bot_status)
    values (${publicId}, ${chat}, 'Group', 'supergroup', ${botStatus}) returning id`;
  return Number(row!.id);
}

async function seedGame(
  publicId: string,
  groupId: number,
  white: number,
  black: number,
  extra: { status?: string; endReason?: string | null; voided?: boolean } = {},
): Promise<number> {
  const [row] = await scratch<{ id: number }[]>`
    insert into games (public_id, group_id, white_id, black_id, rated, fen, status, end_reason, voided_at)
    values (${publicId}, ${groupId}, ${white}, ${black}, true, ${INITIAL_FEN},
      ${extra.status ?? 'active'}, ${extra.endReason ?? null},
      ${extra.voided ? new Date() : null})
    returning id`;
  return Number(row!.id);
}

/** Runs `query` as the reader role in a transaction that never commits. */
function asReader(query: string): Promise<unknown> {
  return scratch.begin(async (tx) => {
    await tx.unsafe(`set local role ${READER}`);
    await tx.unsafe(query);
    throw new RolledBack();
  });
}

class RolledBack extends Error {}

async function readerChecks(): Promise<void> {
  await expect(asReader('select count(*) from stats.users')).rejects.toBeInstanceOf(RolledBack);
  await expect(asReader('select count(*) from public.users')).rejects.toThrow(/permission denied/);
}

async function viewColumns(): Promise<Record<string, string[]>> {
  const rows = await scratch<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'stats' order by table_name, ordinal_position`;
  const out: Record<string, string[]> = {};
  for (const row of rows) (out[row.table_name] ??= []).push(row.column_name);
  return out;
}

describe('stats views', () => {
  it('exposes exactly the agreed columns', async () => {
    const views = await scratch<{ table_name: string }[]>`
      select table_name from information_schema.views where table_schema = 'stats'
      order by table_name`;
    expect(views.map((v) => v.table_name)).toEqual(Object.keys(VIEWS).sort());
    const columns = await viewColumns();
    for (const [view, expected] of Object.entries(VIEWS)) {
      expect(columns[view], view).toEqual(expected);
    }
  });

  it('counts people, leaving out the engine and keeping deleted users flagged', async () => {
    const alice = await seedUser('Alice');
    const bob = await seedUser('Bob');
    const carol = await seedUser('Carol');
    const group = await seedGroup('gpeople', -2000001);
    await seedGame('gpeople1', group, alice, bob);
    await scratch`update users set deleted_at = now() where id = ${bob}`;
    const rows = await scratch<{ id: number; has_played: boolean; deleted: boolean }[]>`
      select id, has_played, deleted from stats.users`;
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    expect(byId.get(alice)).toMatchObject({ has_played: true, deleted: false });
    expect(byId.get(bob)).toMatchObject({ has_played: true, deleted: true });
    expect(byId.get(carol)).toMatchObject({ has_played: false, deleted: false });
    expect(byId.has(await engineId())).toBe(false);
  });

  it('classifies games', async () => {
    const [a, b] = [await seedUser('GA'), await seedUser('GB')];
    const engine = await engineId();
    const group = await seedGroup('ggames', -2000002);
    await seedGame('gm-active', group, a, b);
    const mate = await seedGame('gm-mate', group, a, b, {
      status: 'finished',
      endReason: 'checkmate',
    });
    await seedGame('gm-abort', group, a, b, { status: 'finished', endReason: 'abort' });
    const voided = await seedGame('gm-void', group, a, b, {
      status: 'finished',
      endReason: 'checkmate',
      voided: true,
    });
    const vsEngine = await seedGame('gm-engine', group, a, engine);
    const rows = await scratch<
      { id: number; counted: boolean; voided: boolean; vs_engine: boolean }[]
    >`select id, counted, voided, vs_engine from stats.games where group_id = ${group}`;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.counted).not.toBeNull();
      expect(row.voided).not.toBeNull();
      expect(row.vs_engine).not.toBeNull();
    }
    const ids = (flag: 'counted' | 'voided' | 'vs_engine') =>
      rows.filter((r) => r[flag]).map((r) => Number(r.id));
    expect(ids('counted')).toEqual([mate]);
    expect(ids('voided')).toEqual([voided]);
    expect(ids('vs_engine')).toEqual([vsEngine]);
  });

  it('flags groups without the bot and refunded tips', async () => {
    const left = await seedGroup('gleft', -2000003, 'left');
    const admin = await seedGroup('gadmin', -2000004, 'administrator');
    const groups = await scratch<{ id: number; bot_present: boolean }[]>`
      select id, bot_present from stats.groups where id in (${left}, ${admin})`;
    const present = new Map(groups.map((g) => [Number(g.id), g.bot_present]));
    expect(present.get(left)).toBe(false);
    expect(present.get(admin)).toBe(true);

    await scratch`
      insert into tips (telegram_user_id, stars, telegram_payment_charge_id, refunded_at)
      values (1, 5, 'charge-refunded', now()), (2, 10, 'charge-kept', null)`;
    const tips = await scratch<{ stars: number; refunded: boolean }[]>`
      select stars, refunded from stats.tips order by stars`;
    expect(tips).toEqual([
      { stars: 5, refunded: true },
      { stars: 10, refunded: false },
    ]);
  });

  it('lets the reader role read stats but not the raw tables', async () => {
    await readerChecks();
  });

  it('rebuilds the views after a staging reset and the reader can still read them', async () => {
    // What runMigrations does on a mismatch with resetOnMismatch (src/db/migrate.ts).
    await scratch.begin(async (tx) => {
      await tx`drop schema if exists drizzle cascade`;
      await tx`drop schema public cascade`;
      await tx`create schema public`;
    });
    await runMigrations(scratchUrl);
    await readerChecks();
    expect(Object.keys(await viewColumns()).sort()).toEqual(Object.keys(VIEWS).sort());
  });
});
