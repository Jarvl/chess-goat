import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs, telegramUpdates } from '../../src/db/schema';
import { applyGameResultToRatings } from '../../src/domain/ratings';
import { coreJobHandlers, ensurePruneScheduled } from '../../src/jobs/handlers';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const worker = () =>
  new JobWorker({ db, log: deps.log, handlers: coreJobHandlers(deps), workerId: 'w' });

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('rebuild_ratings', () => {
  it('rebuilds the group and re-edits the cards whose deltas changed', async () => {
    const group = await insertGroup(db);
    const [alice, bob, carol] = await Promise.all([insertUser(db), insertUser(db), insertUser(db)]);
    const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
    const finished = (w: number, b: number, result: '1-0' | '1/2-1/2', d: number) =>
      insertGame(db, group.id, w, b, {
        status: 'finished',
        result,
        endReason: 'resignation',
        finishedAt: day(d),
        plyCount: 20,
      });
    const a = await finished(alice.id, bob.id, '1-0', 1);
    const b = await finished(bob.id, carol.id, '1-0', 2);
    const c = await finished(carol.id, alice.id, '1/2-1/2', 3);
    for (const game of [a, b, c]) await applyGameResultToRatings(db, game, game.finishedAt!);
    await db
      .update(games)
      .set({ voidedAt: sql`now()` })
      .where(eq(games.id, b.id));
    await enqueue(db, {
      kind: 'rebuild_ratings',
      payload: { groupId: group.id },
      dedupKey: `ratings:${group.publicId}`,
    });

    expect(await worker().runOnce()).toBe(1);

    const pending = await db
      .select()
      .from(jobs)
      .where(sql`${jobs.doneAt} is null`);
    expect(pending.map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${c.publicId}`],
    ]);
  });
});

describe('prune', () => {
  it('deletes old updates and old done jobs, keeps recent ones, and re-arms itself for tomorrow', async () => {
    await db.insert(telegramUpdates).values([
      { updateId: 1, receivedAt: sql`now() - interval '8 days'` },
      { updateId: 2, receivedAt: sql`now() - interval '1 day'` },
    ]);
    await db.insert(jobs).values([
      { kind: 'edit_card', doneAt: sql`now() - interval '31 days'` },
      { kind: 'edit_card', doneAt: sql`now() - interval '1 day'` },
    ]);
    await ensurePruneScheduled(db);

    expect(await worker().runOnce()).toBe(1);

    expect((await db.select().from(telegramUpdates)).map((row) => row.updateId)).toEqual([2]);
    const remaining = await db.select().from(jobs).orderBy(jobs.id);
    expect(remaining.filter((job) => job.kind === 'edit_card')).toHaveLength(1);
    const prune = remaining.find((job) => job.kind === 'prune');
    expect(prune?.doneAt).toBeNull();
    const [row] = await db.execute(
      sql`select extract(epoch from (run_at - now())) as seconds from jobs where kind = 'prune'`,
    );
    expect(Number(row?.seconds)).toBeGreaterThan(86_000);

    await ensurePruneScheduled(db);
    const [again] = await db.execute(
      sql`select extract(epoch from (run_at - now())) as seconds from jobs where kind = 'prune'`,
    );
    expect(Number(again?.seconds)).toBeGreaterThan(86_000);
  });
});
