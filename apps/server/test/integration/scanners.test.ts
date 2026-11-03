import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  abortStaleBotGames,
  forfeitOverdueGames,
  runScannersOnce,
  sendDueReminders,
  startScanners,
} from '../../src/clock/scanners';
import { games, jobs } from '../../src/db/schema';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertBot, insertChallenge, insertGame, world, played } from '../helpers/fixtures';

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

const DAY = 86_400_000;
const minutesAgo = (ms: number) => new Date(Date.now() - ms);

describe('abortStaleBotGames', () => {
  async function botGame(overrides: Parameters<typeof insertGame>[4] = {}) {
    const { group, alice } = await world(db, { game: false });
    const a = await insertBot(db, alice);
    const b = await insertBot(db, alice);
    return insertGame(db, group.id, a.id, b.id, {
      botPlayers: 2,
      timePerMove: null,
      ...overrides,
    });
  }

  it('aborts a clockless bot-vs-bot game idle for over 30 days', async () => {
    const game = await botGame({ lastMoveAt: minutesAgo(30 * DAY + 60_000) });
    const published: string[] = [];
    onTestFinished(deps.bus.subscribe(game.publicId, () => published.push(game.publicId)));
    expect(await abortStaleBotGames(deps)).toBe(1);
    const after = await reload(game.id);
    expect(after.status).toBe('finished');
    expect(after.result).toBe('*');
    expect(after.endReason).toBe('abort');
    expect(after.whiteRatingBefore).toBeNull();
    expect(after.whiteRatingAfter).toBeNull();
    expect(after.blackRatingBefore).toBeNull();
    expect(after.blackRatingAfter).toBeNull();
    expect(published).toEqual([game.publicId]);
  });

  it('leaves one idle for 29 days', async () => {
    const game = await botGame({ lastMoveAt: minutesAgo(29 * DAY) });
    expect(await abortStaleBotGames(deps)).toBe(0);
    expect((await reload(game.id)).status).toBe('active');
  });

  it('uses startedAt when nobody has moved', async () => {
    const stale = await botGame({ startedAt: minutesAgo(31 * DAY) });
    const fresh = await botGame({ startedAt: minutesAgo(DAY) });
    expect(await abortStaleBotGames(deps)).toBe(1);
    expect((await reload(stale.id)).status).toBe('finished');
    expect((await reload(fresh.id)).status).toBe('active');
  });

  it('never touches clocked bot-vs-bot games or human games', async () => {
    const old = minutesAgo(60 * DAY);
    const clocked = await botGame({ timePerMove: 86400, lastMoveAt: old });
    const { group, alice, bob } = await world(db, { game: false });
    const human = await insertGame(db, group.id, alice.id, bob.id, {
      timePerMove: null,
      lastMoveAt: old,
      startedAt: old,
    });
    expect(await abortStaleBotGames(deps)).toBe(0);
    expect((await reload(clocked.id)).status).toBe('active');
    expect((await reload(human.id)).status).toBe('active');
  });
});

describe('runScannersOnce and startScanners', () => {
  it('covers forfeits, reminders and challenge expiry in one pass', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    await insertGame(db, group.id, bob.id, alice.id, { reminderInSeconds: -1 });
    await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -1 });
    expect(await runScannersOnce(deps)).toEqual({
      forfeits: 1,
      reminders: 1,
      expiries: 1,
      staleBotGames: 0,
    });
  });

  it('reports staleBotGames', async () => {
    const { group, alice } = await world(db, { game: false });
    const a = await insertBot(db, alice);
    const b = await insertBot(db, alice);
    await insertGame(db, group.id, a.id, b.id, {
      botPlayers: 2,
      timePerMove: null,
      startedAt: minutesAgo(31 * DAY),
    });
    expect(await runScannersOnce(deps)).toMatchObject({ staleBotGames: 1 });
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
