import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, type UserRow } from '../../src/db/schema';
import { playMove } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
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

type Node = { move: string; reply: string; children: Node[] };
type View = { ply: number; yourTurn: boolean; moves: string[]; premoveTree: Node[] };
type Inbox = { entries: Record<string, unknown>[] };

const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

const leaf = (move: string, reply: string): Node => ({ move, reply, children: [] });

/** Rook (the bot, white) has played 1. e4; bob (black) is to move at ply 1. */
async function setup() {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  const game = await insertGame(db, group.id, bot.id, human.id);
  const opened = await call<View>('make_move', {
    bot: 'Rook',
    game_id: game.publicId,
    move: 'e4',
    expected_ply: 0,
  });
  expect(opened.isError).toBeFalsy();
  const humanMove = (uci: string, expectedPly: number) =>
    playMove(api.deps, {
      gameId: game.publicId,
      userId: human.id,
      uci,
      expectedPly,
      clientMoveId: `bob-${expectedPly}`,
    });
  const row = async () => (await db.select().from(games).where(eq(games.id, game.id)))[0]!;
  return { bot, human, game, humanMove, row };
}

/** e5 is answered by Nf3; d5 by e4e6, which a pawn can't do; a7a1 can't be played at all. */
const TREE: Node[] = [
  { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5')] },
  leaf('d7d5', 'e4e6'),
  leaf('a7a1', 'd2d4'),
];

describe('set_premoves', () => {
  it('stores a tree holding an illegal opponent move and an illegal reply', async () => {
    const { game } = await setup();
    const out = await call<View>('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: TREE,
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.premoveTree).toEqual(TREE);
    const got = await call<View>('get_game', { bot: 'Rook', game_id: game.publicId });
    expect(got.structuredContent!.premoveTree).toEqual(TREE);
  });

  it('fires: the opponent plays a move whose reply is legal and the reply is played', async () => {
    const { game, humanMove, row } = await setup();
    await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: TREE,
    });
    await humanMove('e7e5', 1);
    const view = await call<View>('get_game', { bot: 'Rook', game_id: game.publicId });
    expect(view.structuredContent).toMatchObject({ ply: 3, moves: ['e4', 'e5', 'Nf3'] });
    expect(view.structuredContent!.premoveTree).toEqual([leaf('b8c6', 'f1b5')]);
    expect((await row()).premoveFailure).toBeNull();
  });

  it('discards the tree at an illegal reply and says so in the inbox until the bot moves', async () => {
    const { game, humanMove, row } = await setup();
    await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: TREE,
    });
    await humanMove('d7d5', 1);

    const view = await call<View>('get_game', { bot: 'Rook', game_id: game.publicId });
    expect(view.structuredContent).toMatchObject({ ply: 2, yourTurn: true, premoveTree: [] });
    expect((await row()).premoveTree).toHaveLength(0);

    const inbox = await call<Inbox>('get_inbox', { bot: 'Rook' });
    expect(inbox.structuredContent!.entries).toEqual([
      expect.objectContaining({
        kind: 'your_move',
        gameId: game.publicId,
        ply: 2,
        premoveFailed: { opponentMove: 'd7d5', reply: 'e4e6' },
      }),
    ]);
    expect(resultText(inbox)).toContain('e4e6');

    const moved = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'exd5',
      expected_ply: 2,
    });
    expect(moved.isError).toBeFalsy();
    expect((await row()).premoveFailure).toBeNull();
    await humanMove('d8d5', 3);
    const after = await call<Inbox>('get_inbox', { bot: 'Rook' });
    expect(after.structuredContent!.entries).toHaveLength(1);
    expect(after.structuredContent!.entries[0]).not.toHaveProperty('premoveFailed');
  });

  it('clears the stored tree with an empty tree', async () => {
    const { game } = await setup();
    await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: TREE,
    });
    const out = await call<View>('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: [],
    });
    expect(out.structuredContent!.premoveTree).toEqual([]);
  });

  it("is refused on the bot's own turn, as in the app", async () => {
    const { game, humanMove } = await setup();
    await humanMove('e7e5', 1);
    const out = await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 2,
      tree: [leaf('b8c6', 'f1b5')],
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      "It's your bot's move. Set premoves only on the opponent's turn — or pass them with make_move, which takes premoves.",
    );
  });

  it('is refused at a stale ply', async () => {
    const { game } = await setup();
    const out = await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 0,
      tree: TREE,
    });
    expect(resultText(out)).toBe(
      'The position has changed; it is now ply 1. Call get_game and choose again.',
    );
  });

  it('names the path of a malformed node', async () => {
    const { game } = await setup();
    const out = await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: [{ move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'e9e4')] }],
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('tree[0].children[0].reply');
    expect(resultText(out)).toContain('Fix that node and send the tree again.');
  });
});

describe('premove line depth', () => {
  const line = (n: number): Node[] => {
    let tree: Node[] = [];
    for (let i = 0; i < n; i += 1) tree = [{ move: 'g8f6', reply: 'g1f3', children: tree }];
    return tree;
  };
  /** Arguments as JSON text, with a tree nested `n` pairs deep: too deep for JSON.stringify. */
  const rawArgs = (head: string, key: string, n: number) =>
    `{${head},"${key}":[${'{"move":"g8f6","reply":"g1f3","children":['.repeat(n)}${']}'.repeat(n)}]}`;

  it('stores and shows a line 200 pairs deep', async () => {
    const { game } = await setup();
    const out = await call<View>('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: line(200),
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.premoveTree).toEqual(line(200));
    const got = await call<View>('get_game', { bot: 'Rook', game_id: game.publicId });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent!.premoveTree).toEqual(line(200));
  });

  it('refuses a line 201 pairs deep, naming the limit', async () => {
    const { game, row } = await setup();
    const out = await call('set_premoves', {
      bot: 'Rook',
      game_id: game.publicId,
      expected_ply: 1,
      tree: line(201),
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('at most 200 pairs deep');
    expect(resultText(out)).toContain('Shorten that line and send the tree again.');
    expect((await row()).premoveTree).toHaveLength(0);
  });

  it('refuses a payload nested 10,000 deep cleanly, in set_premoves and make_move', async () => {
    const { game, humanMove, row } = await setup();
    const set = await callTool(
      api.app,
      token,
      'set_premoves',
      {},
      {
        rawArguments: rawArgs(
          `"bot":"Rook","game_id":"${game.publicId}","expected_ply":1`,
          'tree',
          10_000,
        ),
      },
    );
    expect(set.isError).toBe(true);
    expect(resultText(set)).toContain('at most 200 pairs deep');
    await humanMove('e7e5', 1);
    const move = await callTool(
      api.app,
      token,
      'make_move',
      {},
      {
        rawArguments: rawArgs(
          `"bot":"Rook","game_id":"${game.publicId}","move":"Nf3","expected_ply":2`,
          'premoves',
          10_000,
        ),
      },
    );
    expect(move.isError).toBe(true);
    expect(resultText(move)).toContain('at most 200 pairs deep');
    expect((await row()).plyCount).toBe(2);
  });
});

describe('make_move with premoves', () => {
  it('sets the tree in the same call, and it fires', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const game = await insertGame(db, group.id, bot.id, human.id);
    const out = await call<View>('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'e4',
      expected_ply: 0,
      premoves: TREE,
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ ply: 1, premoveTree: TREE });
    await playMove(api.deps, {
      gameId: game.publicId,
      userId: human.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'bob-1',
    });
    const view = await call<View>('get_game', { bot: 'Rook', game_id: game.publicId });
    expect(view.structuredContent).toMatchObject({ ply: 3, moves: ['e4', 'e5', 'Nf3'] });
  });

  it('refuses a malformed tree before moving', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const game = await insertGame(db, group.id, bot.id, human.id);
    const out = await call('make_move', {
      bot: 'Rook',
      game_id: game.publicId,
      move: 'e4',
      expected_ply: 0,
      premoves: [leaf('e7e5', 'g1f3'), leaf('e7e5', 'd2d4')],
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('tree[1].move');
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row!.plyCount).toBe(0);
  });
});
