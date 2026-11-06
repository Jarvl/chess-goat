import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, moves, users, type UserRow } from '../../src/db/schema';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
  played,
} from '../helpers/fixtures';
import { touchMember } from '../../src/domain/members';
import { callTool, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let token: string;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type View = {
  gameId: string;
  status: string;
  ply: number;
  yourTurn: boolean;
  drawOffer: string;
  result: string | null;
  endReason: string | null;
  moves: string[];
  fen: string;
};
const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

async function setup(botIsWhite = true) {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  const game = botIsWhite
    ? await insertGame(db, group.id, bot.id, human.id)
    : await insertGame(db, group.id, human.id, bot.id);
  return { group, bot, human, game };
}

describe('make_move', () => {
  it('plays a SAN move and then a UCI move', async () => {
    const { game } = await setup();
    const first = await call<View>('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'e4',
      expected_ply: 0,
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ ply: 1, yourTurn: false, moves: ['e4'] });
    const [current] = await db.select().from(games).where(eq(games.id, game.id));
    await played(db, current!, ['e7e5']);
    const second = await call<View>('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'g1f3',
      expected_ply: 2,
    });
    expect(second.structuredContent).toMatchObject({ ply: 3, moves: ['e4', 'e5', 'Nf3'] });
  });

  it('answers a repeat of the same call with the same position and one move row', async () => {
    const { game } = await setup();
    const args = { bot: 'Rook', game_id: game.publicId, move: 'e4', expected_ply: 0 };
    const a = await call<View>('make_move', args);
    const b = await call<View>('make_move', args);
    expect(b.isError).toBeFalsy();
    expect(b.structuredContent).toEqual(a.structuredContent);
    const rows = await db.select().from(moves).where(eq(moves.gameId, game.id));
    expect(rows).toHaveLength(1);
  });

  it('gives the stale text for a different move at the old ply', async () => {
    const { game } = await setup();
    await call('make_move', { bot: 'Rook', game_id: game.publicId, move: 'e4', expected_ply: 0 });
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'd4',
      expected_ply: 0,
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      'The position has changed; it is now ply 1. Call get_game and choose again.',
    );
  });

  it('says it is not the bot turn', async () => {
    const { game } = await setup(false);
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'e5',
      expected_ply: 0,
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      "It isn't your move. Call get_inbox with wait_seconds to wait for your turn.",
    );
  });

  it('lists the legal moves for an illegal one', async () => {
    const { game } = await setup();
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'Ke5',
      expected_ply: 0,
    });
    expect(out.isError).toBe(true);
    const text = resultText(out);
    expect(text).toMatch(/^Ke5 isn't legal here\. Legal moves: /);
    expect(text).toContain('Nf3 (g1f3)');
    expect((text.match(/\(/g) ?? []).length).toBe(20);
  });

  it('caps the legal-move list at 30', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    const game = await insertGame(db, group.id, bot.id, human.id, {
      fen: 'R6R/3Q4/1Q4Q1/4Q3/2Q4Q/Q4Q2/pp1Q4/kBNN1KB1 w - - 0 1',
    });
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'Zz9',
      expected_ply: 0,
    });
    expect((resultText(out).match(/\(/g) ?? []).length).toBe(30);
  });

  it('treats another owner game as not found and touches activity', async () => {
    const { game, bot } = await setup();
    await call('make_move', { bot: 'Rook', game_id: game.publicId, move: 'e4', expected_ply: 0 });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });
});

describe('game_action', () => {
  it('resigns', async () => {
    const { game } = await setup();
    const out = await call<View>('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'resign',
    });
    expect(out.structuredContent).toMatchObject({
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
    });
  });

  it('aborts before both have moved', async () => {
    const { game } = await setup();
    const out = await call<View>('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'abort',
    });
    expect(out.structuredContent).toMatchObject({ status: 'finished', endReason: 'abort' });
  });

  it('offers, declines, and accepts a draw', async () => {
    const { game } = await setup();
    await played(db, game, ['e2e4', 'e7e5']);
    const offered = await call<View>('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'offer_draw',
    });
    expect(offered.structuredContent!.drawOffer).toBe('from_you');
    // the human answers by declining; then the human offers and the bot declines
    await db
      .update(games)
      .set({ drawOfferBy: 'black', drawOfferPly: 2 })
      .where(eq(games.id, game.id));
    const declined = await call<View>('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'decline_draw',
    });
    expect(declined.structuredContent!.drawOffer).toBe('none');
    await db
      .update(games)
      .set({ drawOfferBy: 'black', drawOfferPly: 2 })
      .where(eq(games.id, game.id));
    const accepted = await call<View>('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'accept_draw',
    });
    expect(accepted.structuredContent).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
  });

  it('says why a draw cannot be claimed', async () => {
    const { game } = await setup();
    const out = await call('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'claim_draw',
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('(code: forbidden)');
  });
});

describe('respond_to_challenge', () => {
  it('accepts a challenge made to the bot and creates the game', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    await touchMember(db, group.id, bot.id);
    const ch = await insertChallenge(db, group.id, human.id, bot.id, { challengerColour: 'white' });
    const out = await call<{ accepted: boolean; game?: View }>('respond_to_challenge', {
      bot: 'Rook',
      challenge_id: ch.publicId,
      accept: true,
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.accepted).toBe(true);
    expect(out.structuredContent!.game).toMatchObject({
      status: 'active',
      ply: 0,
      yourTurn: false,
    });
  });

  it('declines and settles it', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const ch = await insertChallenge(db, group.id, human.id, bot.id);
    const out = await call<{ accepted: boolean; game?: View }>('respond_to_challenge', {
      bot: 'Rook',
      challenge_id: ch.publicId,
      accept: false,
    });
    expect(out.structuredContent).toEqual({ accepted: false });
    const [row] = await db.select().from(challenges).where(eq(challenges.id, ch.id));
    expect(row!.status).toBe('declined');
  });

  it('refuses an open challenge', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    await touchMember(db, group.id, bot.id);
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const ch = await insertChallenge(db, group.id, human.id, null);
    const out = await call('respond_to_challenge', {
      bot: 'Rook',
      challenge_id: ch.publicId,
      accept: true,
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe("Bots can't take open challenges.");
  });

  it('does not know an unknown challenge', async () => {
    await insertBot(db, owner, { firstName: 'Rook' });
    const out = await call('respond_to_challenge', {
      bot: 'Rook',
      challenge_id: 'nope',
      accept: true,
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('Challenge not found');
  });
});
