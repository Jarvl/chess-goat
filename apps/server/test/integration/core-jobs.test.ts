import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  games,
  jobs,
  matchNotes,
  runnerLinkCodes,
  telegramUpdates,
  turnLeases,
  type GameRow,
} from '../../src/db/schema';
import { createLinkCode } from '../../src/domain/runners';
import { applyGameResultToRatings } from '../../src/domain/ratings';
import { coreJobHandlers, ensurePruneScheduled } from '../../src/jobs/handlers';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertRunner,
  insertUser,
} from '../helpers/fixtures';

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

  it('edits no card for a bot-vs-bot game whose deltas changed', async () => {
    const group = await insertGroup(db);
    const [alice, bob] = await Promise.all([insertUser(db), insertUser(db)]);
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(Date.UTC(2026, 8, 1, 12)),
      plyCount: 20,
      botPlayers: 2,
    });
    await enqueue(db, {
      kind: 'rebuild_ratings',
      payload: { groupId: group.id },
      dedupKey: `ratings:${group.publicId}`,
    });

    expect(await worker().runOnce()).toBe(1);

    // The snapshot was written (it had none), but no card edit was queued for it.
    const [after] = await db.select().from(games).where(eq(games.id, game.id));
    expect(after?.whiteRatingAfter).not.toBeNull();
    const pending = await db
      .select()
      .from(jobs)
      .where(sql`${jobs.doneAt} is null`);
    expect(pending).toEqual([]);
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

describe('prune of turns', () => {
  const ago = (s: number) => new Date(Date.now() - s * 1000);
  const soon = (s: number) => new Date(Date.now() + s * 1000);
  const prune = async () => {
    await ensurePruneScheduled(db);
    expect(await worker().runOnce()).toBe(1);
  };
  const kinds = async () =>
    (await db.select().from(turnLeases).orderBy(turnLeases.id)).map((l) => [l.botId, l.kind]);
  const notedGames = async () =>
    (await db.select().from(matchNotes).orderBy(matchNotes.gameId)).map((n) => n.gameId);

  async function scene() {
    const group = await insertGroup(db);
    const owner = await insertUser(db);
    const human = await insertUser(db);
    const bot = await insertBot(db, owner);
    const finished = (): Promise<GameRow> =>
      insertGame(db, group.id, bot.id, human.id, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: ago(60),
      });
    return { group, owner, human, bot, finished };
  }

  it('deletes expired turns, with a game-over row’s match notes; keeps unexpired ones', async () => {
    const { bot, finished } = await scene();
    const [old, recent] = [await finished(), await finished()];
    await db.insert(turnLeases).values([
      { botId: bot.id, kind: 'game_over', gameId: old.id, expiresAt: ago(1) },
      { botId: bot.id, kind: 'game_over', gameId: recent.id, expiresAt: soon(3600) },
      { botId: bot.id, kind: 'practice', expiresAt: ago(1) },
    ]);
    await db.insert(matchNotes).values([
      { botId: bot.id, gameId: old.id, body: 'old' },
      { botId: bot.id, gameId: recent.id, body: 'recent' },
    ]);
    await prune();
    expect(await kinds()).toEqual([[bot.id, 'game_over']]);
    expect(await notedGames()).toEqual([recent.id]);
  });

  it('deletes the turn rows of deleted bots', async () => {
    const { group, owner, human, bot } = await scene();
    const gone = await insertBot(db, owner, { deletedAt: ago(10) });
    const runner = await insertRunner(db, owner.id);
    const live = await insertGame(db, group.id, bot.id, human.id);
    const theirs = await insertGame(db, group.id, gone.id, human.id);
    await db.insert(turnLeases).values([
      { botId: gone.id, kind: 'move', gameId: theirs.id, ply: 0 },
      { botId: gone.id, kind: 'practice', expiresAt: soon(600) },
      {
        botId: bot.id,
        kind: 'move',
        gameId: live.id,
        ply: 0,
        runnerId: runner.id,
        leasedUntil: soon(300),
      },
    ]);
    await prune();
    expect(await kinds()).toEqual([[bot.id, 'move']]);
  });

  it('deletes unleased rows of turns that resolved; keeps a live lease and a pending turn', async () => {
    const { group, owner, human, bot, finished } = await scene();
    const runner = await insertRunner(db, owner.id);
    const [ended, held] = [await finished(), await finished()];
    const live = await insertGame(db, group.id, bot.id, human.id);
    const declined = await insertChallenge(db, group.id, human.id, bot.id, { status: 'declined' });
    await db.insert(turnLeases).values([
      { botId: bot.id, kind: 'move', gameId: ended.id, ply: 4, failures: 1 },
      { botId: bot.id, kind: 'draw_offer', gameId: ended.id, ply: 5, leasedUntil: ago(30) },
      { botId: bot.id, kind: 'challenge', challengeId: declined.id },
      {
        botId: bot.id,
        kind: 'move',
        gameId: held.id,
        ply: 8,
        runnerId: runner.id,
        leasedUntil: soon(300),
      },
      { botId: bot.id, kind: 'move', gameId: live.id, ply: 0, failures: 1 },
    ]);
    await prune();
    const rows = await db.select().from(turnLeases).orderBy(turnLeases.id);
    expect(rows.map((l) => l.gameId)).toEqual([held.id, live.id]);
  });

  it('deletes match notes of games over with no game-over row; keeps an active game’s', async () => {
    const { group, human, bot, finished } = await scene();
    const [ended, offered] = [await finished(), await finished()];
    const live = await insertGame(db, group.id, bot.id, human.id);
    await db
      .insert(turnLeases)
      .values({ botId: bot.id, kind: 'game_over', gameId: offered.id, expiresAt: soon(3600) });
    await db.insert(matchNotes).values([
      { botId: bot.id, gameId: ended.id, body: 'orphan' },
      { botId: bot.id, gameId: offered.id, body: 'last look' },
      { botId: bot.id, gameId: live.id, body: 'in play' },
    ]);
    await prune();
    expect(await notedGames()).toEqual([offered.id, live.id].sort((a, b) => a - b));
  });

  it('deletes expired link codes and keeps unexpired ones', async () => {
    // Two owners: making a code purges its own owner's expired ones.
    await createLinkCode(db, (await insertUser(db)).id, {}, ago(601));
    const { expiresAt } = await createLinkCode(db, (await insertUser(db)).id, {}, new Date());
    await prune();
    expect((await db.select().from(runnerLinkCodes)).map((c) => c.expiresAt)).toEqual([expiresAt]);
  });

  it('counts what it pruned in its log, and nothing else', async () => {
    const lines: unknown[] = [];
    const log: typeof deps.log = Object.create(deps.log);
    log.info = ((obj: unknown) => void lines.push(obj)) as typeof log.info;
    const { bot } = await scene();
    await db.insert(turnLeases).values({ botId: bot.id, kind: 'practice', expiresAt: ago(1) });
    await ensurePruneScheduled(db);
    const w = new JobWorker({
      db,
      log,
      handlers: coreJobHandlers({ ...deps, log }),
      workerId: 'w',
    });
    expect(await w.runOnce()).toBe(1);
    expect(lines).toContainEqual({
      expired: 1,
      deletedBots: 0,
      resolved: 0,
      matchNotes: 0,
      linkCodes: 0,
    });
  });
});
