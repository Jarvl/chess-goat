import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, users, type UserRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
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
import { callTool, claimFor, mcpCall, resultText, startTestMcp } from '../helpers/mcp';
import { playMoveDto } from '../helpers/moves';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Node = { move: string; reply: string; children: Node[] };
type View = {
  gameId: string;
  status: string;
  ply: number;
  yourTurn: boolean;
  drawOffer: string;
  result: string | null;
  endReason: string | null;
  moves: string[];
  premoveTree: Node[];
  pgn?: string;
};

/** The bot (white, Rook) is to move at ply 0 against bob. */
async function moveTurn(botIsWhite = true) {
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

/** The bot has played e4 and bob has offered a draw: a draw-offer turn at ply 1. */
async function drawOfferTurn() {
  const t = await moveTurn();
  const game = await played(db, t.game, ['e2e4']);
  await db
    .update(games)
    .set({ drawOfferBy: 'black', drawOfferPly: 1 })
    .where(eq(games.id, game.id));
  return { ...t, game };
}

const toolNames = async (token: string) =>
  (
    ((await mcpCall(api.app, token, 'tools/list')).response?.result?.tools ?? []) as {
      name: string;
    }[]
  ).map((t) => t.name);

describe('tools by kind', () => {
  it('offers exactly get_position, make_move, game_action and set_notes on a move turn', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    expect(await toolNames(token)).toEqual([
      'get_position',
      'make_move',
      'game_action',
      'set_notes',
    ]);
  });

  it('offers exactly respond_to_challenge and set_notes on a challenge turn', async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, bot.id);
    await insertChallenge(db, group.id, human.id, bot.id);
    const { token } = await claimFor(api, bot);
    expect(await toolNames(token)).toEqual(['respond_to_challenge', 'set_notes']);
  });

  it('offers exactly game_action, set_premoves and set_notes on a draw-offer turn', async () => {
    const { bot } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    expect(await toolNames(token)).toEqual(['game_action', 'set_premoves', 'set_notes']);
    const tools = (await mcpCall(api.app, token, 'tools/list')).response?.result?.tools as {
      name: string;
      inputSchema: { properties: { action?: { enum: string[] } } };
    }[];
    const action = tools.find((t) => t.name === 'game_action')!.inputSchema.properties.action!;
    expect(action.enum).toEqual(['accept_draw', 'decline_draw']);
  });

  it('takes no bot, game, challenge or ply input', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const tools = (await mcpCall(api.app, token, 'tools/list')).response?.result?.tools as {
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    const keys = tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}));
    for (const key of ['bot', 'game_id', 'challenge_id', 'expected_ply']) {
      expect(keys).not.toContain(key);
    }
  });
});

describe('get_position', () => {
  it('shows the turn game, with the PGN when detailed, and does not touch activity', async () => {
    const { bot, game } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'get_position');
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ gameId: game.publicId, ply: 0, yourTurn: true });
    const detailed = await callTool<View>(api.app, token, 'get_position', { format: 'detailed' });
    expect(detailed.structuredContent!.pgn).toBeDefined();
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).toBeNull();
  });
});

describe('make_move', () => {
  it('plays a SAN move and records activity', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'make_move', { move: 'e4' });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ ply: 1, yourTurn: false, moves: ['e4'] });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it('plays a UCI move', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'make_move', { move: 'g1f3' });
    expect(out.structuredContent).toMatchObject({ ply: 1, moves: ['Nf3'] });
  });

  it('lists the legal moves for an illegal one', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'make_move', { move: 'Ke5' });
    expect(out.isError).toBe(true);
    const text = resultText(out);
    expect(text).toMatch(/^Ke5 isn't legal here\. Legal moves: /);
    expect(text).toContain('Nf3 (g1f3)');
    expect((text.match(/\(/g) ?? []).length).toBe(20);
  });

  it('refuses a second make_move in the same session', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    expect((await callTool(api.app, token, 'make_move', { move: 'e4' })).isError).toBeFalsy();
    const again = await callTool(api.app, token, 'make_move', { move: 'd4' });
    expect(again.isError).toBe(true);
    expect(resultText(again)).toBe('This turn has ended; stop.');
  });

  it('refuses a move on a token whose turn the opponent already ended', async () => {
    const { bot, game } = await moveTurn();
    const { token } = await claimFor(api, bot);
    await played(db, game, ['e2e4']);
    const out = await callTool(api.app, token, 'make_move', { move: 'd4' });
    expect(resultText(out)).toBe('This turn has ended; stop.');
  });
});

describe('game_action on a move turn', () => {
  const act = async (botIsWhite: boolean, action: string) => {
    const t = await moveTurn(botIsWhite);
    const { token } = await claimFor(api, t.bot);
    return { ...t, token, out: await callTool<View>(api.app, token, 'game_action', { action }) };
  };

  it('resigns', async () => {
    const { out } = await act(true, 'resign');
    expect(out.structuredContent).toMatchObject({
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
    });
  });

  it('aborts before both have moved', async () => {
    const { out } = await act(true, 'abort');
    expect(out.structuredContent).toMatchObject({ status: 'finished', endReason: 'abort' });
  });

  it('offers a draw', async () => {
    const t = await moveTurn();
    await played(db, t.game, ['e2e4', 'e7e5']);
    const { token } = await claimFor(api, t.bot);
    const out = await callTool<View>(api.app, token, 'game_action', { action: 'offer_draw' });
    expect(out.structuredContent!.drawOffer).toBe('from_you');
  });

  it('says why a draw cannot be claimed', async () => {
    const { out } = await act(true, 'claim_draw');
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      'No draw can be claimed here. Call get_game to see what the bot can do now.',
    );
  });
});

describe('draw-offer turn', () => {
  it('accepts the draw', async () => {
    const { bot } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'game_action', { action: 'accept_draw' });
    expect(out.structuredContent).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
  });

  it('declines the draw', async () => {
    const { bot } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'game_action', { action: 'decline_draw' });
    expect(out.structuredContent).toMatchObject({ status: 'active', drawOffer: 'none' });
  });

  it('refuses resign, and the game goes on', async () => {
    const { bot, game } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    const reply = await mcpCall(api.app, token, 'tools/call', {
      name: 'game_action',
      arguments: { action: 'resign' },
    });
    const result = reply.response?.result as { isError?: boolean } | undefined;
    expect(reply.response?.error !== undefined || result?.isError === true).toBe(true);
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row!.status).toBe('active');
  });

  it('sets premoves for the position after the offer', async () => {
    const { bot } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    const tree = [{ move: 'e7e5', reply: 'g1f3', children: [] }];
    const out = await callTool<View>(api.app, token, 'set_premoves', { premoves: tree });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.premoveTree).toEqual(tree);
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it('names a malformed premove tree', async () => {
    const { bot } = await drawOfferTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'set_premoves', { premoves: [{ move: 'e7e5' }] });
    expect(out.isError).toBe(true);
  });
});

describe('respond_to_challenge', () => {
  async function challenged() {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    await touchMember(db, group.id, bot.id);
    const ch = await insertChallenge(db, group.id, human.id, bot.id, {
      challengerColour: 'white',
    });
    return { bot, ch };
  }

  it('accepts the challenge and creates the game', async () => {
    const { bot } = await challenged();
    const { token } = await claimFor(api, bot);
    const out = await callTool<{ accepted: boolean; game?: View }>(
      api.app,
      token,
      'respond_to_challenge',
      { accept: true },
    );
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.accepted).toBe(true);
    expect(out.structuredContent!.game).toMatchObject({
      status: 'active',
      ply: 0,
      yourTurn: false,
    });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });

  it('declines and settles it', async () => {
    const { bot, ch } = await challenged();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'respond_to_challenge', { accept: false });
    expect(out.structuredContent).toEqual({ accepted: false });
    const [row] = await db.select().from(challenges).where(eq(challenges.id, ch.id));
    expect(row!.status).toBe('declined');
  });

  it('ends the turn once answered', async () => {
    const { bot } = await challenged();
    const { token } = await claimFor(api, bot);
    await callTool(api.app, token, 'respond_to_challenge', { accept: false });
    const again = await callTool(api.app, token, 'respond_to_challenge', { accept: true });
    expect(resultText(again)).toBe('This turn has ended; stop.');
  });
});

describe('premove trees through make_move', () => {
  const leaf = (move: string, reply: string): Node => ({ move, reply, children: [] });
  /** e5 is answered by Nf3; d5 by e4e6, which a pawn can't do; a7a1 can't be played at all. */
  const TREE: Node[] = [
    { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5')] },
    leaf('d7d5', 'e4e6'),
    leaf('a7a1', 'd2d4'),
  ];

  it('sets the tree in the same call, and it fires', async () => {
    const { bot, game, human } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<View>(api.app, token, 'make_move', { move: 'e4', premoves: TREE });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ ply: 1, premoveTree: TREE });
    await playMoveDto(api.deps, {
      gameId: game.publicId,
      userId: human.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'bob-1',
    });
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row!.plyCount).toBe(3);
  });

  it('refuses a malformed tree before playing the move', async () => {
    const { bot, game } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'make_move', {
      move: 'e4',
      premoves: [{ move: 1 }],
    });
    expect(out.isError).toBe(true);
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row!.plyCount).toBe(0);
  });

  it('refuses a payload nested 10,000 deep cleanly', async () => {
    const { bot, game } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const deep = `[${'{"move":"g8f6","reply":"g1f3","children":['.repeat(10_000)}${']}'.repeat(10_000)}]`;
    const out = await callTool(
      api.app,
      token,
      'make_move',
      {},
      {
        rawArguments: `{"move":"Nf3","premoves":${deep}}`,
      },
    );
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('at most 200 pairs deep');
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row!.plyCount).toBe(0);
  });

  it('accepts an 8,000-pair premove tree', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const squares = [...'abcdefgh'].flatMap((f) => [...'12345678'].map((r) => f + r));
    const moves: string[] = [];
    for (const from of squares) {
      for (const to of squares) if (from !== to && moves.length < 200) moves.push(from + to);
    }
    // 200 roots, each a line of 40 pairs: 8,000 in all.
    const chain = (n: number): string =>
      n === 0 ? '[]' : `[{"move":"g8f6","reply":"g1f3","children":${chain(n - 1)}}]`;
    const roots = moves.map((m) => `{"move":"${m}","reply":"d2d4","children":${chain(39)}}`);
    const body = `{"move":"e4","premoves":[${roots.join(',')}]}`;
    expect(body.length).toBeLessThan(512 * 1024);
    const out = await callTool<View>(api.app, token, 'make_move', {}, { rawArguments: body });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.ply).toBe(1);
  });
});
