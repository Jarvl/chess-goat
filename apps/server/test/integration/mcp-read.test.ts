import { encodePremoveBytes } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, users, type UserRow } from '../../src/db/schema';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser, played } from '../helpers/fixtures';
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
  group: { groupId: string; title: string };
  you: string;
  opponent: { name: string; isBot: boolean };
  status: string;
  ply: number;
  toMove: string;
  yourTurn: boolean;
  fen: string;
  board: string;
  moves: string[];
  legalMoves: { san: string; uci: string }[];
  drawOffer: string;
  premoveTree: unknown[];
  pgn?: string;
};
const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

async function setup() {
  const group = await insertGroup(db);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  const game = await insertGame(db, group.id, bot.id, human.id);
  return { group, bot, human, game };
}

describe('get_game', () => {
  it('shows a bot to move its legal moves in SAN and UCI', async () => {
    const { group, game } = await setup();
    const out = await call<View>('get_game', { bot: 'rook', game_id: game.publicId });
    expect(out.isError).toBeFalsy();
    const view = out.structuredContent!;
    expect(view).toMatchObject({
      gameId: game.publicId,
      group: { groupId: group.publicId, title: group.title },
      you: 'white',
      opponent: { name: '@bob', isBot: false },
      status: 'active',
      ply: 0,
      toMove: 'white',
      yourTurn: true,
      moves: [],
      drawOffer: 'none',
      premoveTree: [],
    });
    expect(view.legalMoves).toHaveLength(20);
    expect(view.legalMoves).toContainEqual({ san: 'Nf3', uci: 'g1f3' });
    expect(view.board.split('\n')[0]).toBe('8 r n b q k b n r');
    expect(view.pgn).toBeUndefined();
    expect(resultText(out)).toContain('Your move');
  });

  it('has no legal moves when it is the opponent to move, and shows the draw offer', async () => {
    const { game } = await setup();
    const moved = await played(db, game, ['e2e4']);
    await db
      .update(games)
      .set({ drawOfferBy: 'black', drawOfferPly: 1 })
      .where(eq(games.id, moved.id));
    const view = (await call<View>('get_game', { bot: 'Rook', game_id: game.publicId }))
      .structuredContent!;
    expect(view).toMatchObject({
      ply: 1,
      toMove: 'black',
      yourTurn: false,
      legalMoves: [],
      moves: ['e4'],
    });
    expect(view.drawOffer).toBe('from_opponent');
  });

  it('plays black from black’s side', async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    const game = await insertGame(db, group.id, human.id, bot.id);
    const view = (await call<View>('get_game', { bot: 'Rook', game_id: game.publicId }))
      .structuredContent!;
    expect(view.you).toBe('black');
    expect(view.board.split('\n')[0]).toBe('1 R N B K Q B N R');
  });

  it('includes the PGN only for the detailed format', async () => {
    const { game } = await setup();
    const view = (
      await call<View>('get_game', { bot: 'Rook', game_id: game.publicId, format: 'detailed' })
    ).structuredContent!;
    expect(view.pgn).toContain('[White "');
  });

  it('refuses a game the bot does not play in', async () => {
    const { game, group } = await setup();
    await insertBot(db, owner, { firstName: 'Other' });
    const out = await call('get_game', { bot: 'Other', game_id: game.publicId });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toMatch(/^Game not found\./);
    const missing = await call('get_game', { bot: 'Other', game_id: 'nope' });
    expect(resultText(missing)).toBe(resultText(out));
    expect(group.id).toBeGreaterThan(0);
  });

  it('touches the bot’s activity', async () => {
    const { bot, game } = await setup();
    expect(bot.lastActiveAt).toBeNull();
    await call('get_game', { bot: 'Rook', game_id: game.publicId });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });
});

describe('get_game premoves', () => {
  it('shows the stored tree only to the side not to move, at the ply it was stored', async () => {
    const { game } = await setup();
    const moved = await played(db, game, ['e2e4']);
    const tree = [{ move: 'e7e5', reply: 'g1f3', children: [] }];
    // Black is to move, so a stored tree is white's (the bot's): shown when the ply matches.
    await db
      .update(games)
      .set({ premoveTree: Buffer.from(encodePremoveBytes(tree)), premoveTreePly: moved.plyCount })
      .where(eq(games.id, moved.id));
    const shown = (await call<View>('get_game', { bot: 'Rook', game_id: game.publicId }))
      .structuredContent!;
    expect(shown.premoveTree).toEqual(tree);
    await db.update(games).set({ premoveTreePly: 0 }).where(eq(games.id, moved.id));
    const stale = (await call<View>('get_game', { bot: 'Rook', game_id: game.publicId }))
      .structuredContent!;
    expect(stale.premoveTree).toEqual([]);
  });
});

describe('get_profile', () => {
  it('lists the ten most recent finished games and touches activity', async () => {
    const { bot, human, group } = await setup();
    for (let i = 0; i < 11; i += 1) {
      const g = await insertGame(db, group.id, bot.id, human.id);
      await db
        .update(games)
        .set({
          status: 'finished',
          result: i === 10 ? '1-0' : '0-1',
          endReason: 'checkmate',
          finishedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        })
        .where(eq(games.id, g.id));
    }
    const out = await call<{
      bot: { name: string; groups: unknown[] };
      recentGames: { gameId: string; opponent: string; result: string; finishedAt: string }[];
    }>('get_profile', { bot: 'rook' });
    expect(out.isError).toBeFalsy();
    const { bot: profile, recentGames } = out.structuredContent!;
    expect(profile.name).toBe('Rook');
    expect(recentGames).toHaveLength(10);
    expect(recentGames[0]).toMatchObject({
      opponent: '@bob',
      result: 'win',
      finishedAt: '2026-01-11T00:00:00.000Z',
    });
    expect(recentGames[1]!.result).toBe('loss');
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });
});
