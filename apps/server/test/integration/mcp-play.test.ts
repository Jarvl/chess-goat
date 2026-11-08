import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, users, type UserRow } from '../../src/db/schema';
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

  it('records activity even when the move is refused', async () => {
    const { game, bot } = await setup();
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'Ke5',
      expected_ply: 0,
    });
    expect(out.isError).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it('treats another owner game as not found and touches activity', async () => {
    const { game, bot } = await setup();
    await call('make_move', { bot: 'Rook', game_id: game.publicId, move: 'e4', expected_ply: 0 });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it("reads a game the bot doesn't play in as no such game", async () => {
    const { group } = await setup();
    const [a, b] = [await insertUser(db), await insertUser(db)];
    const theirs = await insertGame(db, group.id, a.id, b.id);
    const notFound =
      "Game not found. That bot doesn't play in a game with that id. Use a gameId from get_inbox or get_profile.";
    for (const game_id of [theirs.publicId, 'no-such-game']) {
      const moved = await call('make_move', { bot: 'Rook', game_id, move: 'e4', expected_ply: 0 });
      expect(resultText(moved)).toBe(notFound);
      const acted = await call('game_action', { bot: 'Rook', game_id, action: 'resign' });
      expect(resultText(acted)).toBe(notFound);
    }
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

  it('says the game is over', async () => {
    const { game } = await setup();
    await db.update(games).set({ status: 'finished', result: '0-1' }).where(eq(games.id, game.id));
    const out = await call('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'offer_draw',
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      'The game is over. Call get_game to see the result, then get_inbox.',
    );
  });

  it('says why a draw cannot be claimed', async () => {
    const { game } = await setup();
    const out = await call('game_action', {
      bot: 'Rook',
      game_id: game.publicId,
      action: 'claim_draw',
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      'No draw can be claimed here. Call get_game to see what the bot can do now.',
    );
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

  it('does not know an open challenge or one the bot sent', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    await touchMember(db, group.id, bot.id);
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const rival = await insertBot(db, human, { firstName: 'Pawn' });
    await touchMember(db, group.id, rival.id);
    const open = await insertChallenge(db, group.id, human.id, null);
    const sent = await insertChallenge(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    for (const ch of [open, sent]) {
      for (const accept of [true, false]) {
        const out = await call('respond_to_challenge', {
          bot: 'Rook',
          challenge_id: ch.publicId,
          accept,
        });
        expect(out.isError).toBe(true);
        expect(resultText(out)).toBe(
          'Challenge not found. That bot has no pending challenge with that id. Use a challengeId from get_inbox.',
        );
      }
    }
    const rows = await db.select().from(challenges);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
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
