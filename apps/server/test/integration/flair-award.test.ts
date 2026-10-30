import { INITIAL_FEN } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs, userFlair, users, type GameRow } from '../../src/db/schema';
import { abortGame, resign } from '../../src/domain/games';
import { awardFlairForGame } from '../../src/flair/award';
import { coreJobHandlers } from '../../src/jobs/handlers';
import { JobWorker } from '../../src/jobs/worker';
import { LINES, play, PROMOTION_FEN, QUEEN_MATE_FEN } from '../helpers/chess';
import {
  holdOpen,
  openTestDb,
  testDeps,
  truncateAll,
  waitForLockWaiters,
  withoutWaiting,
} from '../helpers/db';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';
import { day, earned, finishedGame, startWearing, worn } from '../helpers/flair';

const { db, close } = openTestDb();
const deps = testDeps(db);
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function players(aliceWears: string[] = []) {
  const group = await insertGroup(db);
  return {
    group,
    alice: await insertUser(db, { flairWorn: aliceWears }),
    bob: await insertUser(db),
  };
}
describe('award_flair', () => {
  it('is enqueued when a game against a person ends, and not for an abort or a bot game', async () => {
    const { group, alice, bob } = await players();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      fen: AFTER_E4_E5,
      plyCount: 2,
    });
    await resign(deps, { gameId: game.publicId, userId: bob.id });
    const aborted = await insertGame(db, group.id, alice.id, bob.id);
    await abortGame(deps, { gameId: aborted.publicId, userId: alice.id });
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const botGame = await insertGame(db, group.id, alice.id, engine!.id, {
      engineLevel: 'beginner',
      rated: false,
      timePerMove: null,
      fen: AFTER_E4_E5,
      plyCount: 2,
    });
    await resign(deps, { gameId: botGame.publicId, userId: alice.id });
    const queued = (await db.select().from(jobs)).filter((job) => job.kind === 'award_flair');
    expect(queued.map((job) => [job.dedupKey, job.payload])).toEqual([
      [`flair:g:${game.publicId}`, { gameId: game.id }],
    ]);
  });

  it('runs as the job and gives 👑 to a winner who captured en passant, and 🐔 to the loser who resigned', async () => {
    const { group, alice, bob } = await players();
    const moves = play(INITIAL_FEN, ...LINES.enPassant);
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      rated: false,
      fen: moves.at(-1)!.fenAfter,
      plyCount: moves.length,
    });
    for (const m of moves) await insertMove(db, game.id, m.ply, m.uci, m.san, m.fenAfter);
    await resign(deps, { gameId: game.publicId, userId: bob.id });
    await new JobWorker({
      db,
      log: deps.log,
      handlers: coreJobHandlers(deps),
      workerId: 'w',
    }).runOnce();
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', game.id]]);
    expect(await earned(db, bob.id)).toEqual([['resigned', game.id]]);
  });

  it('awards 🏰 for a win with O-O-O and ♟️ for a promotion', async () => {
    const { group, alice, bob } = await players();
    const castled = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.bothCastleQueenside,
    });
    const promoted = await finishedGame(db, group.id, alice.id, bob.id, 3, '1-0', {
      start: PROMOTION_FEN,
      line: ['e7e8q'],
    });
    await awardFlairForGame(db, castled.id);
    await awardFlairForGame(db, promoted.id);
    expect(await earned(db, alice.id)).toEqual([
      ['promotion_win', promoted.id],
      ['queenside_castle_win', castled.id],
    ]);
    expect(await earned(db, bob.id)).toEqual([]);
  });

  it('gives 🪤 only to the side that was mated', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.scholarsMateQh5,
      over: { endReason: 'checkmate' },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, bob.id)).toEqual([['scholars_mate_loss', game.id]]);
    // Black took nothing before the mate, so White's win is flawless.
    expect(await earned(db, alice.id)).toEqual([['flawless_mate', game.id]]);
  });

  it('awards ♟️ for a promotion in a game the promoter lost', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '0-1', {
      start: PROMOTION_FEN,
      line: ['e7e8q'],
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([['promotion_win', game.id]]);
    expect(await earned(db, bob.id)).toEqual([]);
  });

  it('awards 🏎️ for a mate within three minutes of the start, and not after', async () => {
    const { group, alice, bob } = await players();
    const mate = (d: number, seconds: number) =>
      finishedGame(db, group.id, alice.id, bob.id, d, '1-0', {
        start: QUEEN_MATE_FEN,
        line: ['a1a8'],
        over: { endReason: 'checkmate', startedAt: new Date(day(d).getTime() - seconds * 1000) },
      });
    const slow = await mate(2, 181);
    await awardFlairForGame(db, slow.id);
    // Black had nothing to capture with, so the mate is also flawless, and White captured
    // nothing, so it is also a pacifist's.
    expect(await earned(db, alice.id)).toEqual([
      ['flawless_mate', slow.id],
      ['pacifist_mate', slow.id],
      ['queen_mate', slow.id],
    ]);
    const quick = await mate(3, 180);
    await awardFlairForGame(db, quick.id);
    expect(await earned(db, alice.id)).toEqual([
      ['flawless_mate', slow.id],
      ['pacifist_mate', slow.id],
      ['queen_mate', slow.id],
      ['quick_mate', quick.id],
    ]);
  });

  it('awards 🌡️ at the third rated win in a row and 🌋 at the tenth', async () => {
    const { group, alice, bob } = await players();
    const played: GameRow[] = [];
    for (let d = 2; d <= 11; d += 1)
      played.push(await finishedGame(db, group.id, alice.id, bob.id, d, '1-0'));
    for (const game of played) await awardFlairForGame(db, game.id);
    // The fifth game against Bob is also their fifth together.
    expect(await earned(db, alice.id)).toEqual([
      ['rival_5', played[4]!.id],
      ['win_streak_10', played[9]!.id],
      ['win_streak_3', played[2]!.id],
      ['win_streak_5', played[4]!.id],
    ]);
  });

  it('awards 🔥 at the fifth rated win in a row, skipping a casual game between', async () => {
    const { group, alice, bob } = await players();
    const plan = [
      [2, '1-0', true],
      [3, '1-0', true],
      [4, '0-1', false],
      [5, '1-0', true],
      [6, '1-0', true],
      [7, '1-0', true],
    ] as const;
    const played: GameRow[] = [];
    for (const [d, result, rated] of plan)
      played.push(
        await finishedGame(db, group.id, alice.id, bob.id, d, result, { over: { rated } }),
      );
    // 🌡️ comes at the third rated win, the casual loss skipped.
    for (const game of played.slice(0, 5)) await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([
      ['rival_5', played[4]!.id],
      ['win_streak_3', played[3]!.id],
    ]);
    await awardFlairForGame(db, played[5]!.id);
    expect(await earned(db, alice.id)).toEqual([
      ['rival_5', played[4]!.id],
      ['win_streak_3', played[3]!.id],
      ['win_streak_5', played[5]!.id],
    ]);
  });

  it('awards 🤝 at the tenth draw, rated or casual', async () => {
    const { group, alice, bob } = await players();
    const draws: GameRow[] = [];
    for (let d = 2; d <= 11; d += 1)
      draws.push(
        await finishedGame(db, group.id, alice.id, bob.id, d, '1/2-1/2', {
          over: { rated: d % 2 === 0 },
        }),
      );
    for (const game of draws.slice(0, 9)) await awardFlairForGame(db, game.id);
    // Their fifth game together earned them both 👬.
    const rival = ['rival_5', draws[4]!.id];
    expect(await earned(db, alice.id)).toEqual([rival]);
    await awardFlairForGame(db, draws[9]!.id);
    expect(await earned(db, alice.id)).toEqual([['draws_10', draws[9]!.id], rival]);
    expect(await earned(db, bob.id)).toEqual([['draws_10', draws[9]!.id], rival]);
  });

  it('gives each player the rung of the rating a rated game left them at', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      over: { whiteRatingAfter: 1612.4, blackRatingAfter: 1449.5 },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([['rank_1600', game.id]]);
    expect(await earned(db, bob.id)).toEqual([['rank_1400', game.id]]);
    const [row] = await db.select().from(userFlair).where(eq(userFlair.userId, alice.id));
    expect(row!.earnedAt).toEqual(day(2));
    expect(await worn(db, alice.id)).toEqual(['rank_1600']);
  });

  it('counts every earlier game toward a streak, however long ago', async () => {
    const { group, alice, bob } = await players();
    const wins: GameRow[] = [];
    for (let d = 2; d <= 6; d += 1)
      wins.push(await finishedGame(db, group.id, alice.id, bob.id, d, '1-0'));
    // Only the fifth game's job runs, as if the first four ended before this deploy.
    await awardFlairForGame(db, wins[4]!.id);
    expect(await earned(db, alice.id)).toEqual([
      ['rival_5', wins[4]!.id],
      ['win_streak_3', wins[4]!.id],
      ['win_streak_5', wins[4]!.id],
    ]);
  });

  it('stores every new flair but fills only the free slots, picking at random', async () => {
    const { group, alice, bob } = await players(['rank_1500', 'draws_10']);
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
      over: { whiteRatingAfter: 1650 },
    });
    await awardFlairForGame(db, game.id, () => 0.99);
    expect(await earned(db, alice.id)).toEqual([
      ['en_passant_win', game.id],
      ['rank_1600', game.id],
    ]);
    expect(await worn(db, alice.id)).toEqual(['rank_1500', 'draws_10', 'en_passant_win']);
  });

  it('changes nothing when it runs again', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
    });
    await awardFlairForGame(db, game.id);
    await db.update(users).set({ flairWorn: [] }).where(eq(users.id, alice.id));
    await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', game.id]]);
    expect(await worn(db, alice.id)).toEqual([]);
  });

  it('keeps flair when its game is voided later, and awards nothing for a game voided before its job ran', async () => {
    const { group, alice, bob } = await players();
    const kept = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
    });
    await awardFlairForGame(db, kept.id);
    await db
      .update(games)
      .set({ voidedAt: day(3) })
      .where(eq(games.id, kept.id));
    const voided = await finishedGame(db, group.id, alice.id, bob.id, 4, '1-0', {
      line: LINES.bothCastleQueenside,
      over: { voidedAt: day(4) },
    });
    await awardFlairForGame(db, voided.id);
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', kept.id]]);
  });

  it('awards a streak it missed at the player’s next rated win', async () => {
    const { group, alice, bob } = await players();
    const wins: GameRow[] = [];
    for (let d = 2; d <= 7; d += 1)
      wins.push(await finishedGame(db, group.id, alice.id, bob.id, d, '1-0'));
    for (const game of [...wins.slice(0, 4), wins[5]!]) await awardFlairForGame(db, game.id);
    // 👬, missed at the fifth game with Bob like 🔥, comes at the sixth.
    expect(await earned(db, alice.id)).toEqual([
      ['rival_5', wins[5]!.id],
      ['win_streak_3', wins[2]!.id],
      ['win_streak_5', wins[5]!.id],
    ]);
  });

  it('awards 🚩 to the player who won on time and 💤 to the one who lost', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      over: { endReason: 'timeout' },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([['timeout_win', game.id]]);
    expect(await earned(db, bob.id)).toEqual([['timed_out', game.id]]);
  });

  it('awards 😈 at the fifth loss to one person, games against others between', async () => {
    const { group, alice, bob } = await players();
    const carol = await insertUser(db);
    const played = [
      await finishedGame(db, group.id, bob.id, alice.id, 2, '1-0'),
      await finishedGame(db, group.id, alice.id, bob.id, 3, '0-1'),
      await finishedGame(db, group.id, bob.id, alice.id, 4, '1-0'),
      await finishedGame(db, group.id, alice.id, bob.id, 5, '0-1'),
      await finishedGame(db, group.id, carol.id, alice.id, 6, '1-0'),
      await finishedGame(db, group.id, alice.id, bob.id, 7, '1-0'),
    ];
    for (const game of played) await awardFlairForGame(db, game.id);
    expect((await earned(db, alice.id)).map(([id]) => id)).not.toContain('nemesis_5');
    const fifth = await finishedGame(db, group.id, bob.id, alice.id, 8, '1-0');
    await awardFlairForGame(db, fifth.id);
    expect(await earned(db, alice.id)).toContainEqual(['nemesis_5', fifth.id]);
  });

  it('counts games against a player who deleted their data', async () => {
    const { group, alice, bob } = await players();
    const played: GameRow[] = [];
    for (let d = 2; d <= 6; d += 1)
      played.push(await finishedGame(db, group.id, alice.id, bob.id, d, '1-0'));
    for (const game of played.slice(0, 4)) await awardFlairForGame(db, game.id);
    await db
      .update(users)
      .set({ deletedAt: day(6) })
      .where(eq(users.id, bob.id));
    await awardFlairForGame(db, played[4]!.id);
    expect(await earned(db, alice.id)).toContainEqual(['rival_5', played[4]!.id]);
  });

  it('skips a player who deleted their data', async () => {
    const { group, alice, bob } = await players();
    await db
      .update(users)
      .set({ deletedAt: day(3) })
      .where(eq(users.id, bob.id));
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.scholarsMateQh5,
      over: { endReason: 'checkmate', whiteRatingAfter: 1612 },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, bob.id)).toEqual([]);
    expect(await earned(db, alice.id)).toEqual([
      ['flawless_mate', game.id],
      ['rank_1600', game.id],
    ]);
  });

  it('waits for a change to the worn list in flight, and awards with the colours reversed do not deadlock', async () => {
    const { group, alice, bob } = await players();
    // Alice has White in the first game and Black in the second; Bob the other way round.
    const first = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.bothCastleQueenside,
    });
    const second = await finishedGame(db, group.id, bob.id, alice.id, 3, '1-0', {
      line: LINES.enPassant,
    });
    // While Alice's change is in flight, the first award queues for her row. Locking one player at
    // a time, the second would take Bob's row (he has White) and queue behind it for hers, and once
    // the change committed the first would want Bob's row: a deadlock.
    const put = await startWearing(db, alice.id, ['rank_1500']);
    const awards: Promise<void>[] = [];
    try {
      awards.push(db.transaction((tx) => awardFlairForGame(tx, first.id)));
      await waitForLockWaiters(db, 1, '%for no key update%');
      awards.push(db.transaction((tx) => awardFlairForGame(tx, second.id)));
      await waitForLockWaiters(db, 2, '%for no key update%');
    } finally {
      put.commit();
      await Promise.allSettled([put.done, ...awards]);
    }
    await Promise.all([put.done, ...awards]);
    expect(await earned(db, alice.id)).toEqual([['queenside_castle_win', first.id]]);
    expect(await earned(db, bob.id)).toEqual([['en_passant_win', second.id]]);
    // The award fills slots from the list the change left (spec §6).
    expect(await worn(db, alice.id)).toEqual(['rank_1500', 'queenside_castle_win']);
  });

  it('lets a game with either player be created while it holds their rows', async () => {
    const { group, alice, bob } = await players();
    const game = await finishedGame(db, group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
    });
    // The award has run but not committed, so it still holds both players' rows.
    const award = await holdOpen(db, (tx) => awardFlairForGame(tx, game.id));
    try {
      // A new game's foreign keys lock its players' rows `for key share`, which the award's lock
      // must let through: `for update` would hold the game back until the award committed.
      await withoutWaiting(db, (tx) => insertGame(tx, group.id, bob.id, alice.id));
    } finally {
      await award.commit();
    }
    expect(await earned(db, alice.id)).toEqual([['en_passant_win', game.id]]);
  });
});
