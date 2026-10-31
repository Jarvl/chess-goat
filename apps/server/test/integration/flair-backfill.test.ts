import { FLAIR, flairBackfillVersion, flairById, type FlairEntry } from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flairBackfills, games, jobs, userFlair, users, type GameRow } from '../../src/db/schema';
import {
  backfillDedupKey,
  backfillPlayer,
  enqueueFlairBackfill,
  pendingBackfills,
  runFlairBackfill,
  type BackfillPair,
} from '../../src/flair/backfill';
import { enqueue } from '../../src/jobs/queue';
import { coreJobHandlers } from '../../src/jobs/handlers';
import { backfillFlairHandler } from '../../src/jobs/handlers/flair';
import { JobWorker } from '../../src/jobs/worker';
import { LINES } from '../helpers/chess';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';
import { day, earned, finishedGame, worn } from '../helpers/flair';

const { db, close } = openTestDb();
const deps = testDeps(db);
beforeEach(() => truncateAll(db));
afterAll(() => close());

async function players() {
  return { group: await insertGroup(db), alice: await insertUser(db), bob: await insertUser(db) };
}
/** Ten draws between the two, on days `from` to `from + 9`; returns the tenth. */
async function tenDraws(groupId: number, a: number, b: number, from: number): Promise<GameRow> {
  let last!: GameRow;
  for (let d = from; d < from + 10; d += 1)
    last = await finishedGame(db, groupId, a, b, d, '1/2-1/2');
  return last;
}
const flair = (...ids: string[]): FlairEntry[] => ids.map((id) => flairById(id)!);
const award = (userId: number, flairId: string, game: GameRow) =>
  db.insert(userFlair).values({ userId, flairId, gameId: game.id, earnedAt: game.finishedAt! });
const recorded = async () =>
  (await db.select().from(flairBackfills).orderBy(flairBackfills.flairId)).map((r) => [
    r.flairId,
    r.version,
  ]);

describe('pendingBackfills', () => {
  const everyFlair: BackfillPair[] = FLAIR.map((f) => ({
    id: f.id,
    version: flairBackfillVersion(f),
  }));

  it('lists every catalog flair at its version when nothing has been backfilled', async () => {
    expect(await pendingBackfills(db)).toEqual(everyFlair);
  });

  it('drops a flair backfilled at its version, and keeps one backfilled at a lower one', async () => {
    await db.insert(flairBackfills).values([
      { flairId: 'en_passant_win', version: 1 },
      { flairId: 'draws_10', version: 0 },
      { flairId: 'retired_flair', version: 1 },
    ]);
    expect(await pendingBackfills(db)).toEqual(everyFlair.filter((p) => p.id !== 'en_passant_win'));
  });
});

describe('backfillPlayer', () => {
  it('awards each rule kind from history at the first game that earned it', async () => {
    const { group, alice, bob } = await players();
    const enPassant = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
    });
    const wins: GameRow[] = [];
    for (let d = 3; d <= 7; d += 1)
      wins.push(await finishedGame(db, group.id, alice.id, bob.id, d, '1-0'));
    const tenth = await tenDraws(group.id, alice.id, bob.id, 8);
    const mated = await finishedGame(db, group.id, bob.id, alice.id, 18, '1-0', {
      line: LINES.scholarsMateQh5,
      over: { endReason: 'checkmate' },
    });
    const rated = await finishedGame(db, group.id, alice.id, bob.id, 19, '1-0', {
      over: { whiteRatingAfter: 1612 },
    });
    const resigned = await finishedGame(db, group.id, bob.id, alice.id, 20, '1-0', {
      over: { endReason: 'resignation' },
    });
    const flagged = await finishedGame(db, group.id, alice.id, bob.id, 21, '0-1', {
      over: { endReason: 'timeout' },
    });
    const flaggedBob = await finishedGame(db, group.id, alice.id, bob.id, 22, '1-0', {
      over: { endReason: 'timeout' },
    });

    expect(await backfillPlayer(db, alice.id, FLAIR)).toEqual({
      // In catalog order.
      added: [
        'rank_1600',
        'en_passant_win',
        'win_streak_3',
        'win_streak_5',
        'draws_10',
        'rival_5',
        'timeout_win',
        'scholars_mate_loss',
        'resigned',
        'timed_out',
      ],
      moved: [],
    });
    // The en passant win is the first of the five in a row, so the third in a row is wins[1].
    expect(await earned(db, alice.id)).toEqual([
      ['draws_10', tenth.id],
      ['en_passant_win', enPassant.id],
      ['rank_1600', rated.id],
      ['resigned', resigned.id],
      // The fifth game with Bob.
      ['rival_5', wins[3]!.id],
      ['scholars_mate_loss', mated.id],
      ['timed_out', flagged.id],
      ['timeout_win', flaggedBob.id],
      ['win_streak_3', wins[1]!.id],
      ['win_streak_5', wins[3]!.id],
    ]);
    const rows = await db.select().from(userFlair).where(eq(userFlair.userId, alice.id));
    const finishedAt = new Map(
      (await db.select().from(games)).map((g) => [g.id, g.finishedAt!.getTime()]),
    );
    for (const row of rows) expect(row.earnedAt.getTime()).toBe(finishedAt.get(row.gameId));
  });

  it('fills no worn slots', async () => {
    const { group, alice, bob } = await players();
    await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', { line: LINES.enPassant });
    await backfillPlayer(db, alice.id, FLAIR);
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', expect.any(Number)]]);
    expect(await worn(db, alice.id)).toEqual([]);
  });

  it('moves a held flair to an earlier game, and leaves it when there is none', async () => {
    const { group, alice, bob } = await players();
    const first = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
    });
    const second = await finishedGame(db, group.id, alice.id, bob.id, 3, '1-0', {
      line: LINES.enPassant,
    });
    const tenth = await tenDraws(group.id, alice.id, bob.id, 4);
    await award(alice.id, 'en_passant_win', second);
    await award(alice.id, 'draws_10', tenth);

    expect(await backfillPlayer(db, alice.id, flair('en_passant_win', 'draws_10'))).toEqual({
      added: [],
      moved: ['en_passant_win'],
    });
    expect(await earned(db, alice.id)).toEqual([
      ['draws_10', tenth.id],
      ['en_passant_win', first.id],
    ]);
    const [row] = await db.select().from(userFlair).where(eq(userFlair.flairId, 'en_passant_win'));
    expect(row!.earnedAt).toEqual(day(2));
  });

  it('never moves an award to a later game', async () => {
    const { group, alice, bob } = await players();
    // Credited before its game was voided; a later game now qualifies too.
    const voided = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
      over: { voidedAt: day(3) },
    });
    await finishedGame(db, group.id, alice.id, bob.id, 4, '1-0', { line: LINES.enPassant });
    await award(alice.id, 'en_passant_win', voided);
    expect(await backfillPlayer(db, alice.id, flair('en_passant_win'))).toEqual({
      added: [],
      moved: [],
    });
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', voided.id]]);
  });

  it('changes nothing when run again', async () => {
    const { group, alice, bob } = await players();
    await tenDraws(group.id, alice.id, bob.id, 2);
    await backfillPlayer(db, alice.id, FLAIR);
    const before = await earned(db, alice.id);
    expect(await backfillPlayer(db, alice.id, FLAIR)).toEqual({ added: [], moved: [] });
    expect(await earned(db, alice.id)).toEqual(before);
  });
});

describe('runFlairBackfill', () => {
  const draws: BackfillPair[] = [{ id: 'draws_10', version: 1 }];

  it('backfills both players of a game and counts the awards per flair', async () => {
    const { group, alice, bob } = await players();
    const tenth = await tenDraws(group.id, alice.id, bob.id, 2);
    expect(await runFlairBackfill(db, draws)).toEqual({
      players: 2,
      added: { draws_10: 2 },
      moved: {},
      next: null,
    });
    expect(await earned(db, alice.id)).toEqual([['draws_10', tenth.id]]);
    expect(await earned(db, bob.id)).toEqual([['draws_10', tenth.id]]);
  });

  it('backfills only the flair it is given', async () => {
    const { group, alice, bob } = await players();
    await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', { line: LINES.enPassant });
    await tenDraws(group.id, alice.id, bob.id, 3);
    await runFlairBackfill(db, draws);
    expect((await earned(db, alice.id)).map(([id]) => id)).toEqual(['draws_10']);
  });

  it('skips deleted players, and sweeps rows of players deleted meanwhile', async () => {
    const { group, alice, bob } = await players();
    const tenth = await tenDraws(group.id, alice.id, bob.id, 2);
    await db
      .update(users)
      .set({ deletedAt: day(20) })
      .where(eq(users.id, bob.id));
    // A row the walk wrote just before its player deleted their data.
    const carol = await insertUser(db, { deletedAt: day(21) });
    await award(carol.id, 'draws_10', tenth);

    expect((await runFlairBackfill(db, draws)).players).toBe(1);
    expect(await earned(db, alice.id)).toEqual([['draws_10', tenth.id]]);
    expect(await earned(db, bob.id)).toEqual([]);
    expect(await earned(db, carol.id)).toEqual([]);
  });

  it('records the pairs after a complete run', async () => {
    await runFlairBackfill(db, [...draws, { id: 'en_passant_win', version: 2 }]);
    expect(await recorded()).toEqual([
      ['draws_10', 1],
      ['en_passant_win', 2],
    ]);
  });

  it('keeps the higher version when recording', async () => {
    await db.insert(flairBackfills).values({ flairId: 'draws_10', version: 3 });
    await runFlairBackfill(db, draws);
    expect(await recorded()).toEqual([['draws_10', 3]]);
  });

  it('walks a chunk of players at a time, and records only after the last', async () => {
    const { group, alice, bob } = await players();
    const carol = await insertUser(db);
    await tenDraws(group.id, alice.id, bob.id, 2);
    const tenth = await tenDraws(group.id, bob.id, carol.id, 12);

    const first = await runFlairBackfill(db, draws, { limit: 2 });
    expect(first).toMatchObject({ players: 2, next: bob.id });
    expect(await earned(db, carol.id)).toEqual([]);
    expect(await recorded()).toEqual([]);

    const rest = await runFlairBackfill(db, draws, { afterUserId: bob.id, limit: 2 });
    expect(rest).toMatchObject({ players: 1, next: null });
    expect(await earned(db, carol.id)).toEqual([['draws_10', tenth.id]]);
    expect(await recorded()).toEqual([['draws_10', 1]]);
  });

  it('records nothing when a player fails, and keeps earlier players’ awards', async () => {
    const { group, alice, bob } = await players();
    const tenth = await tenDraws(group.id, alice.id, bob.id, 2);
    const backfillOne: typeof backfillPlayer = (tx, userId, candidates) => {
      if (userId === bob.id) throw new Error('boom');
      return backfillPlayer(tx, userId, candidates);
    };
    await expect(runFlairBackfill(db, draws, { backfillOne })).rejects.toThrow('boom');
    expect(await earned(db, alice.id)).toEqual([['draws_10', tenth.id]]);
    expect(await recorded()).toEqual([]);
  });
});

describe('enqueueFlairBackfill', () => {
  const backfillJobs = async () =>
    (await db.select().from(jobs)).filter((job) => job.kind === 'backfill_flair');

  it('enqueues one job for the pending set, and none when nothing is pending', async () => {
    await enqueueFlairBackfill(db);
    await enqueueFlairBackfill(db);
    const pending = await pendingBackfills(db);
    expect((await backfillJobs()).map((job) => [job.dedupKey, job.payload])).toEqual([
      [backfillDedupKey(pending), { flair: pending }],
    ]);

    await db.delete(jobs);
    await db
      .insert(flairBackfills)
      .values(pending.map((pair) => ({ flairId: pair.id, version: pair.version })));
    await enqueueFlairBackfill(db);
    expect(await backfillJobs()).toEqual([]);
  });
});

describe('backfill_flair', () => {
  const worker = () =>
    new JobWorker({ db, log: deps.log, handlers: coreJobHandlers(deps), workerId: 'w' });

  it('backfills from the job and records the pairs', async () => {
    const { group, alice, bob } = await players();
    const tenth = await tenDraws(group.id, alice.id, bob.id, 2);
    await enqueue(db, {
      kind: 'backfill_flair',
      payload: { flair: [{ id: 'draws_10', version: 1 }] },
      dedupKey: 'flair:backfill:draws_10@1',
    });
    await worker().runOnce();
    expect(await earned(db, alice.id)).toEqual([['draws_10', tenth.id]]);
    expect(await recorded()).toEqual([['draws_10', 1]]);
    const [job] = await db.select().from(jobs);
    expect(job!.doneAt).not.toBeNull();
  });

  it('runs a chunk per lease, keeping its place in the payload, without counting attempts', async () => {
    const { group, alice, bob } = await players();
    const tenth = await tenDraws(group.id, alice.id, bob.id, 2);
    await enqueue(db, {
      kind: 'backfill_flair',
      payload: { flair: [{ id: 'draws_10', version: 1 }] },
      dedupKey: 'flair:backfill:draws_10@1',
    });
    const chunked = new JobWorker({
      db,
      log: deps.log,
      handlers: { backfill_flair: backfillFlairHandler(deps, { chunk: 1 }) },
      workerId: 'w',
    });

    await chunked.runOnce();
    const [waiting] = await db.select().from(jobs);
    expect(waiting!.doneAt).toBeNull();
    expect(waiting!.attempts).toBe(0);
    expect(waiting!.payload).toEqual({
      flair: [{ id: 'draws_10', version: 1 }],
      afterUserId: alice.id,
    });
    expect(await earned(db, alice.id)).toEqual([['draws_10', tenth.id]]);
    expect(await earned(db, bob.id)).toEqual([]);
    expect(await recorded()).toEqual([]);

    for (let i = 0; i < 3 && (await db.select().from(jobs))[0]!.doneAt === null; i += 1)
      await chunked.runOnce();
    expect((await db.select().from(jobs))[0]!.doneAt).not.toBeNull();
    expect(await earned(db, bob.id)).toEqual([['draws_10', tenth.id]]);
    expect(await recorded()).toEqual([['draws_10', 1]]);
  });

  it('leaves a job from a newer build for a newer worker', async () => {
    await enqueue(db, {
      kind: 'backfill_flair',
      payload: { flair: [{ id: 'retired_flair', version: 1 }] },
      dedupKey: 'flair:backfill:retired_flair@1',
    });
    await worker().runOnce();
    const [job] = await db
      .select({
        doneAt: jobs.doneAt,
        attempts: jobs.attempts,
        waitSeconds: sql<number>`extract(epoch from ${jobs.runAt} - now())::float`,
      })
      .from(jobs);
    expect(job!.doneAt).toBeNull();
    expect(job!.attempts).toBe(0);
    expect(job!.waitSeconds).toBeGreaterThan(25);
    expect(job!.waitSeconds).toBeLessThanOrEqual(30);
    expect(await recorded()).toEqual([]);
  });
});
