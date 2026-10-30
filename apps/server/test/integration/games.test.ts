import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActions, dmMessages, games, jobs, moves, ratings, users } from '../../src/db/schema';
import { abortGame, getGameDto, playMove, resign, voidGame } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
  type GameOverrides,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6, White to play Qxf7#. */
const BEFORE_SCHOLARS_MATE = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

async function setup(overrides: GameOverrides = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, carol, game };
}

let moveCounter = 0;
const move = (
  gameId: string,
  userId: number,
  uci: string,
  expectedPly: number,
  clientMoveId?: string,
) =>
  playMove(deps, {
    gameId,
    userId,
    uci,
    expectedPly,
    clientMoveId: clientMoveId ?? `client-${(moveCounter += 1)}`,
  });

const jobList = () => db.select().from(jobs).orderBy(jobs.id);
const secondsUntil = async (column: 'deadline_at' | 'reminder_at', id: number) => {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from games where id = ${id}`,
  );
  return row?.seconds === null ? null : Number(row?.seconds);
};

const resultDms = async () =>
  (await db.select().from(jobs))
    .filter((job) => job.kind === 'send_dm' && job.payload.template === 'result')
    .map((job) => job.payload.userId);

describe('game end DMs', () => {
  const liveDm = (userId: number, gameId: number, kind: 'turn' | 'waiting', stub: string) =>
    db.insert(dmMessages).values({
      userId,
      chatId: userId,
      gameId,
      telegramMessageId: 100 + userId,
      kind,
      stub,
      sentAt: new Date(),
    });

  it('sends the result DM to the mated player only', async () => {
    const { game, bob, alice } = await setup({ fen: BEFORE_SCHOLARS_MATE, plyCount: 6 });
    await move(game.publicId, alice.id, 'h5f7', 6);
    expect(await resultDms()).toEqual([bob.id]);
  });

  it('sends no result DM for an abort or a void', async () => {
    const { game, alice, carol } = await setup();
    await abortGame(deps, { gameId: game.publicId, userId: alice.id });
    const other = await insertGame(db, game.groupId, alice.id, carol.id);
    await voidGame(deps, { gameId: other.publicId, adminUserId: alice.id });
    expect(await resultDms()).toEqual([]);
  });

  it("retires both players' live DMs when the game ends, even with DMs off", async () => {
    const { game, alice, bob } = await setup();
    await db
      .update(users)
      .set({ prefs: { notifications: false } })
      .where(eq(users.id, bob.id));
    await liveDm(alice.id, game.id, 'waiting', '✓ You played 1. e4 · waiting for Bob');
    await liveDm(bob.id, game.id, 'turn', 'Game vs Alice ended');
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    expect(await db.select().from(dmMessages)).toEqual([]);
    const retires = (await db.select().from(jobs)).filter((job) => job.kind === 'retire_dm');
    expect(retires.map((job) => [job.payload.userId, job.payload.text])).toEqual([
      [alice.id, '✓ You played 1. e4 · waiting for Bob'],
      [bob.id, 'Game vs Alice ended'],
    ]);
  });
});

describe('playMove', () => {
  it('plays a legal move, resets the opponent’s clock and enqueues the card edit and turn DM', async () => {
    // A clock nearly run down, so only the move resetting it can put a day back on it.
    const { game, alice, bob } = await setup({ deadlineInSeconds: 60 });
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({
      fen: AFTER_E4,
      plyCount: 1,
      version: 1,
      viewerRole: 'white',
      status: 'active',
    });
    expect(dto.moves).toEqual([
      expect.objectContaining({ ply: 1, uci: 'e2e4', san: 'e4', fenAfter: AFTER_E4 }),
    ]);
    expect(await secondsUntil('deadline_at', game.id)).toBeGreaterThan(86_390);
    expect((await jobList()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}`],
    ]);
  });

  it("marks the mover's live DM as waiting", async () => {
    const { game, alice } = await setup();
    await db.insert(dmMessages).values({
      userId: alice.id,
      chatId: 11,
      gameId: game.id,
      telegramMessageId: 101,
      kind: 'turn',
      stub: 'Game vs Bob ended',
      sentAt: new Date(),
    });
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect(await db.select().from(dmMessages)).toMatchObject([
      { kind: 'waiting', stub: '✓ You played 1. e4 · waiting for Bob' },
    ]);
    const retire = (await jobList()).find((job) => job.kind === 'retire_dm');
    expect(retire?.payload).toMatchObject({
      action: 'wait',
      telegramMessageId: 101,
      text: '✓ You played 1. e4 · waiting for Bob',
    });
  });

  it('does nothing for a mover with no live DM', async () => {
    const { game, alice } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect((await jobList()).map((job) => job.kind)).not.toContain('retire_dm');
  });

  it('sets a reminder only when the opponent allows DMs and the control is eight hours or more', async () => {
    const { game, alice, bob } = await setup();
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, bob.id));
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect(await secondsUntil('reminder_at', game.id)).toBeGreaterThan(77_750);
    const short = await setup({ timePerMove: 3600 });
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, short.bob.id));
    await move(short.game.publicId, short.alice.id, 'e2e4', 0);
    expect(await secondsUntil('reminder_at', short.game.id)).toBeNull();
    const muted = await setup();
    await db
      .update(users)
      .set({ dmAllowed: true, prefs: { notifications: false } })
      .where(eq(users.id, muted.bob.id));
    await move(muted.game.publicId, muted.alice.id, 'e2e4', 0);
    expect(await secondsUntil('reminder_at', muted.game.id)).toBeNull();
  });

  it('is idempotent for a retried client move id', async () => {
    const { game, alice } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0, 'retry-me');
    const again = await move(game.publicId, alice.id, 'e2e4', 0, 'retry-me');
    expect(again.plyCount).toBe(1);
    expect(await db.select().from(moves)).toHaveLength(1);
  });

  it('rejects a stale expected ply', async () => {
    const { game, alice, bob } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0);
    await expect(move(game.publicId, bob.id, 'e7e5', 0)).rejects.toMatchObject({
      code: 'stale_state',
    });
  });

  it('rejects a move out of turn and from a spectator', async () => {
    const { game, bob, carol } = await setup();
    await expect(move(game.publicId, bob.id, 'e7e5', 0)).rejects.toMatchObject({
      code: 'not_your_turn',
    });
    await expect(move(game.publicId, carol.id, 'e2e4', 0)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects an illegal move and leaves the game untouched', async () => {
    const { game, alice } = await setup();
    await expect(move(game.publicId, alice.id, 'e2e5', 0)).rejects.toMatchObject({
      code: 'illegal_move',
    });
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row?.version).toBe(0);
    expect(await jobList()).toHaveLength(0);
  });

  it('applies the timeout instead of a move that arrives after the deadline', async () => {
    const { game, alice } = await setup({ deadlineInSeconds: -1 });
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({
      status: 'finished',
      result: '*',
      endReason: 'timeout_abort',
      plyCount: 0,
    });
    expect(dto.moves).toEqual([]);
    const kinds = (await jobList()).map((job) => [job.kind, job.dedupKey]);
    // An abort updates the card and posts no result photo; the players get no DM either.
    expect(kinds).toEqual([['edit_card', `card:g:${game.publicId}`]]);
  });

  it('scores a late move after real play as a rated loss on time', async () => {
    const { game, alice } = await setup({ deadlineInSeconds: -1, fen: AFTER_E4_E5, plyCount: 2 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await insertMove(db, game.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
    const dto = await move(game.publicId, alice.id, 'g1f3', 2);
    expect(dto).toMatchObject({
      status: 'finished',
      result: '0-1',
      endReason: 'timeout',
      plyCount: 2,
    });
    expect(await db.select().from(ratings)).toHaveLength(2);
    expect((await jobList()).map((job) => job.kind)).toContain('lichess_import');
  });

  it('finishes the game on checkmate with ratings, snapshots and a Lichess import', async () => {
    const { game, alice } = await setup({ fen: BEFORE_SCHOLARS_MATE, plyCount: 6 });
    const dto = await move(game.publicId, alice.id, 'h5f7', 6);
    expect(dto).toMatchObject({
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      plyCount: 7,
      version: 2,
    });
    expect(dto.white.ratingAfter).toBeGreaterThan(1500);
    expect(dto.black.ratingAfter).toBeLessThan(1500);
    expect(dto.white.rating).toBe(1500);
    expect(dto.analysisUrl).toContain('Qxf7%23');
    expect(dto.deadlineAt).toBeNull();
    const dedups = (await jobList()).map((job) => job.dedupKey);
    expect(dedups).toEqual(
      expect.arrayContaining([
        `card:g:${game.publicId}`,
        `lichess:${game.publicId}`,
        `result:g:${game.publicId}`,
      ]),
    );
    // The mated player hears the result; nobody gets a turn DM.
    expect(
      (await jobList()).filter((job) => job.kind === 'send_dm').map((job) => job.payload.template),
    ).toEqual(['result']);
  });

  it('clears the opponent’s draw offer when the mover is not the offerer, and keeps the mover’s own', async () => {
    const { game, alice } = await setup({ drawOfferBy: 'black', drawOfferPly: 0 });
    expect((await move(game.publicId, alice.id, 'e2e4', 0)).drawOffer).toBeNull();
    const own = await setup({ drawOfferBy: 'white', drawOfferPly: 0 });
    expect((await move(own.game.publicId, own.alice.id, 'e2e4', 0)).drawOffer).toEqual({
      by: 'white',
      atPly: 0,
    });
  });

  it('serialises two concurrent moves for the same ply', async () => {
    const { game, alice } = await setup();
    const results = await Promise.allSettled([
      move(game.publicId, alice.id, 'e2e4', 0, 'first-tap'),
      move(game.publicId, alice.id, 'd2d4', 0, 'second-tap'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'stale_state' });
    expect(await db.select().from(moves)).toHaveLength(1);
  });
});

describe('resign, abort, void', () => {
  it('resigns as a rated loss', async () => {
    const { game, alice, bob } = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    const dto = await resign(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'resignation' });
    expect(await db.select().from(ratings)).toHaveLength(2);
    expect((await jobList()).map((job) => [job.kind, job.dedupKey, job.payload])).toEqual([
      ['edit_card', `card:g:${game.publicId}`, { gameId: game.id }],
      ['send_result_photo', `result:g:${game.publicId}`, { gameId: game.id }],
      ['lichess_import', `lichess:${game.publicId}`, { gameId: game.id }],
      [
        'send_dm',
        `dm:${alice.id}:g:${game.publicId}`,
        { userId: alice.id, template: 'result', gameId: game.id },
      ],
      ['award_flair', `flair:g:${game.publicId}`, { gameId: game.id }],
    ]);
  });

  it('applies a passed deadline before a resignation by the player who is not flagged', async () => {
    const { game, bob } = await setup({ deadlineInSeconds: -1, fen: AFTER_E4_E5, plyCount: 2 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await insertMove(db, game.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
    const dto = await resign(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '0-1', endReason: 'timeout' });
  });

  it('allows an abort only before both players have moved', async () => {
    const { game, alice, bob } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0);
    const dto = await abortGame(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '*', endReason: 'abort' });
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect((await jobList()).map((job) => job.kind)).not.toContain('send_result_photo');
    const later = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    await expect(
      abortGame(deps, { gameId: later.game.publicId, userId: later.alice.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('voids a running game without a result and a finished one with a rebuild', async () => {
    const running = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    const voided = await voidGame(deps, {
      gameId: running.game.publicId,
      adminUserId: running.carol.id,
    });
    expect(voided).toMatchObject({
      status: 'finished',
      result: '*',
      endReason: 'voided',
      voided: true,
    });
    expect((await jobList()).map((job) => job.kind)).not.toContain('lichess_import');
    expect((await jobList()).map((job) => job.dedupKey)).toContain(
      `result:g:${running.game.publicId}`,
    );
    expect(voided.lichessUrl).toBeUndefined();

    const done = await setup({
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      finishedAt: new Date(),
      plyCount: 7,
    });
    await db.delete(jobs);
    const dto = await voidGame(deps, { gameId: done.game.publicId, adminUserId: done.carol.id });
    expect(dto).toMatchObject({ result: '1-0', endReason: 'checkmate', voided: true });
    expect((await jobList()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['rebuild_ratings', `ratings:${done.group.publicId}`],
      ['edit_card', `card:g:${done.game.publicId}`],
    ]);
    const audit = await db.select().from(adminActions);
    expect(audit.map((row) => [row.action, row.targetGameId, row.adminUserId])).toEqual([
      ['void', running.game.id, running.carol.id],
      ['void', done.game.id, done.carol.id],
    ]);
  });
});

describe('getGameDto', () => {
  it('describes a running game for a spectator without Lichess links', async () => {
    const { game, carol } = await setup({ fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: carol.id });
    expect(dto).toMatchObject({
      viewerRole: 'spectator',
      claims: { threefold: false, fiftyMove: false },
      drawOffer: null,
      white: { name: 'Alice', rating: 1500, provisional: true, ratingAfter: null },
    });
    expect(dto.lichessUrl).toBeUndefined();
    expect(dto.analysisUrl).toBeUndefined();
    expect(Math.abs(Date.parse(dto.serverTime) - Date.now())).toBeLessThan(5_000);
  });

  it('reports the pre-game snapshot as the rating of a finished rated game', async () => {
    const { game, alice } = await setup({
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      whiteRatingBefore: 1500,
      whiteRatingAfter: 1534.4,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRatingAfter: 1465.6,
      blackRdBefore: 350,
      blackRdAfter: 290,
    });
    await db.insert(ratings).values({
      groupId: game.groupId,
      userId: alice.id,
      rating: 1610,
      rd: 80,
      volatility: 0.06,
      gamesPlayed: 9,
    });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: null });
    expect(dto.white).toMatchObject({
      rating: 1500,
      provisional: true,
      ratingAfter: 1534,
      provisionalAfter: true,
    });
    expect(dto.black).toMatchObject({ rating: 1500, ratingAfter: 1466 });
  });

  it('hides the reverted rating delta of a voided game', async () => {
    const { game } = await setup({
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      voidedAt: new Date(),
      whiteRatingBefore: 1500,
      whiteRatingAfter: 1534.4,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRatingAfter: 1465.6,
      blackRdBefore: 350,
      blackRdAfter: 290,
    });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: null });
    expect(dto.voided).toBe(true);
    expect(dto.white).toMatchObject({ rating: 1500, ratingAfter: null, provisionalAfter: null });
    expect(dto.black).toMatchObject({ rating: 1500, ratingAfter: null, provisionalAfter: null });
  });
});
