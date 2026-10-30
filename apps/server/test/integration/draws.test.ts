import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs, ratings } from '../../src/db/schema';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../src/domain/draws';
import { playMove } from '../../src/domain/games';

import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { world, resultDms } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

/** After 1. e4 e5 2. Nf3: Black to move. */
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

let n = 0;
const play = (gameId: string, userId: number, uci: string, expectedPly: number) =>
  playMove(deps, { gameId, userId, uci, expectedPly, clientMoveId: `draw-test-${(n += 1)}` });

describe('draw result DMs', () => {
  it('sends the result DM to the offerer when the draw is accepted', async () => {
    const { game, alice, bob } = await world(db);
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    await acceptDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(await resultDms(db)).toEqual([alice.id]);
  });

  it("sends the result DM to the claimer's opponent", async () => {
    const { game, alice, bob } = await world(db, {
      game: {
        fen: '8/8/8/8/8/8/1R6/K6k w - - 100 60',
        plyCount: 120,
      },
    });
    await claimDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(await resultDms(db)).toEqual([alice.id]);
  });
});

describe('draw offers', () => {
  it('sends a draw offer DM when the recipient is to move', async () => {
    const { game, alice, bob } = await world(db);
    await offerDraw(deps, { gameId: game.publicId, userId: bob.id });
    const dms = (await db.select().from(jobs)).filter((job) => job.kind === 'send_dm');
    expect(dms.map((job) => [job.dedupKey, job.payload])).toEqual([
      [
        `dm:${alice.id}:g:${game.publicId}`,
        { userId: alice.id, template: 'draw_offer', gameId: game.id },
      ],
    ]);
  });

  it('sends no DM for an offer by the player to move', async () => {
    const { game, alice } = await world(db);
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain('send_dm');
  });

  it('records an offer, refuses a second one while it stands, and lets the opponent decline', async () => {
    const { game, alice, bob } = await world(db);
    const offered = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(offered.drawOffer).toEqual({ by: 'white', atPly: 0 });
    expect(offered.version).toBe(1);
    await expect(offerDraw(deps, { gameId: game.publicId, userId: bob.id })).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await expect(
      acceptDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      details: { reason: 'no_offer' },
    });
    const declined = await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(declined.drawOffer).toBeNull();
    expect(declined.status).toBe('active');
  });

  it('allows one offer per own move', async () => {
    const { game, alice, bob } = await world(db);
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    await expect(
      offerDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await play(game.publicId, alice.id, 'e2e4', 0);
    const again = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(again.drawOffer).toEqual({ by: 'white', atPly: 1 });
  });

  it('ends the game by agreement when the opponent accepts', async () => {
    const { game, alice, bob } = await world(db);
    await play(game.publicId, alice.id, 'e2e4', 0);
    await play(game.publicId, bob.id, 'e7e5', 1);
    await offerDraw(deps, { gameId: game.publicId, userId: bob.id });
    const dto = await acceptDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(dto).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
      drawOffer: null,
    });
    expect(await db.select().from(ratings)).toHaveLength(2);
  });

  it('applies a passed deadline before a draw acceptance by the flagged player', async () => {
    const { game, bob } = await world(db, {
      game: {
        fen: AFTER_NF3,
        plyCount: 3,
        drawOfferBy: 'white',
        drawOfferPly: 3,
        deadlineInSeconds: -1,
      },
    });
    const dto = await acceptDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'timeout' });
    expect(await db.select().from(ratings)).toHaveLength(2);
  });

  it('applies a passed deadline before an offer', async () => {
    const { game, bob } = await world(db, {
      game: { fen: AFTER_NF3, plyCount: 3, deadlineInSeconds: -1 },
    });
    const dto = await offerDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'timeout' });
  });
});

describe('draw claims', () => {
  it('lets a player claim threefold repetition once the arbiter reports it', async () => {
    const { game, alice, bob } = await world(db);
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    let ply = 0;
    for (const uci of shuffle) {
      await play(game.publicId, ply % 2 === 0 ? alice.id : bob.id, uci, ply);
      ply += 1;
    }
    await expect(
      claimDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).resolves.toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'threefold_claim',
    });
  });

  it('lets a player claim the fifty-move rule at halfmove 100', async () => {
    const { game, bob } = await world(db, {
      game: { fen: '8/8/8/8/8/8/1R6/K6k w - - 100 60', plyCount: 120 },
    });
    const dto = await claimDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', endReason: 'fifty_move_claim' });
  });

  it('applies a passed deadline before a draw claim', async () => {
    const { game, bob } = await world(db, {
      game: { fen: AFTER_NF3, plyCount: 3, deadlineInSeconds: -1 },
    });
    const dto = await claimDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'timeout' });
  });

  it('refuses a claim when neither rule applies', async () => {
    const { game, alice } = await world(db);
    await expect(
      claimDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'no_claim' },
    });
  });
});
