import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  forfeitOverdueGames,
  runScannersOnce,
  sendDueReminders,
  startScanners,
} from '../../src/clock/scanners';
import { games, jobs } from '../../src/db/schema';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, world, played } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const reload = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('forfeitOverdueGames', () => {
  it('ends only overdue games and publishes each one', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const overdue = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    const fresh = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: 3600 });
    const published: string[] = [];
    const stops = [
      deps.bus.subscribe(overdue.publicId, () => published.push(overdue.publicId)),
      deps.bus.subscribe(fresh.publicId, () => published.push(fresh.publicId)),
    ];
    onTestFinished(() => stops.forEach((stop) => stop()));

    expect(await forfeitOverdueGames(deps)).toBe(1);

    expect(await reload(overdue.id)).toMatchObject({
      status: 'finished',
      result: '*',
      endReason: 'timeout_abort',
    });
    expect((await reload(fresh.id)).status).toBe('active');
    expect(published).toEqual([overdue.publicId]);
    expect(await forfeitOverdueGames(deps)).toBe(0);
  });

  it('scores a flag fall after real play as a loss', async () => {
    const { game } = await world(db, { game: { deadlineInSeconds: -1 } });
    await played(db, game, ['e2e4', 'e7e5']);
    await forfeitOverdueGames(deps);
    expect(await reload(game.id)).toMatchObject({
      status: 'finished',
      result: '0-1',
      endReason: 'timeout',
    });
  });
});

describe('timeout result DMs', () => {
  it('sends the result DM to both players on timeout', async () => {
    const { alice, bob, game } = await world(db, { game: { deadlineInSeconds: -1 } });
    await played(db, game, ['e2e4', 'e7e5']);
    await forfeitOverdueGames(deps);
    const dms = (await db.select().from(jobs)).filter(
      (job) => job.kind === 'send_dm' && job.payload.template === 'result',
    );
    expect(dms.map((job) => job.payload.userId).sort()).toEqual([alice.id, bob.id].sort());
  });
});

describe('sendDueReminders', () => {
  it('enqueues one reminder DM for the player to move and clears the column', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await insertGame(db, group.id, alice.id, bob.id, { reminderInSeconds: -1 });
    expect(await sendDueReminders(deps)).toBe(1);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({
      kind: 'send_dm',
      dedupKey: `dm:${alice.id}:g:${game.publicId}`,
    });
    expect(job?.payload).toEqual({ userId: alice.id, template: 'reminder', gameId: game.id });
    expect((await reload(game.id)).reminderAt).toBeNull();
    expect(await sendDueReminders(deps)).toBe(0);
  });
});

describe('runScannersOnce and startScanners', () => {
  it('covers forfeits, reminders and challenge expiry in one pass', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    await insertGame(db, group.id, bob.id, alice.id, { reminderInSeconds: -1 });
    await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -1 });
    expect(await runScannersOnce(deps)).toEqual({ forfeits: 1, reminders: 1, expiries: 1 });
  });

  it('keeps scanning on an interval until stopped', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    const scanners = startScanners(deps, { intervalMs: 20 });
    try {
      const deadline = Date.now() + 5_000;
      while ((await reload(game.id)).status === 'active' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await scanners.stop();
    }
    expect((await reload(game.id)).status).toBe('finished');
  });
});
