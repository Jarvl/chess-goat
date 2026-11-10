import { encodePremoveBytes } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, type UserRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { loadTurnView, renderTurnPrompt } from '../../src/domain/turnPrompt';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser, played } from '../helpers/fixtures';
import { callTool, claimFor, resultText, startTestMcp } from '../helpers/mcp';
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
  ply: number;
  you: string;
  yourTurn: boolean;
  board: string;
  moves: string[];
  legalMoves: unknown[];
  drawOffer: string;
  premoveTree: Node[];
  pgn?: string;
};

const leaf = (move: string, reply: string): Node => ({ move, reply, children: [] });

/** e5 is answered by Nf3; d5 by e4e6, which a pawn can't do; a7a1 can't be played at all. */
const TREE: Node[] = [
  { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5')] },
  leaf('d7d5', 'e4e6'),
  leaf('a7a1', 'd2d4'),
];

/**
 * Rook (white) has played e4 and bob has offered a draw: a draw-offer turn at ply 1, the turn that
 * can set premoves.
 */
async function offerTurn() {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  const fresh = await insertGame(db, group.id, bot.id, human.id);
  const game = await played(db, fresh, ['e2e4']);
  await db
    .update(games)
    .set({ drawOfferBy: 'black', drawOfferPly: 1 })
    .where(eq(games.id, game.id));
  const { token } = await claimFor(api, bot);
  const humanMove = (uci: string, expectedPly: number) =>
    playMoveDto(api.deps, {
      gameId: game.publicId,
      userId: human.id,
      uci,
      expectedPly,
      clientMoveId: `bob-${expectedPly}`,
    });
  const row = async () => (await db.select().from(games).where(eq(games.id, game.id)))[0]!;
  const set = (premoves: unknown) => callTool<View>(api.app, token, 'set_premoves', { premoves });
  return { bot, human, game, token, humanMove, row, set };
}

/** The prompt of the bot's next turn, as the runner would give it. */
async function nextPrompt(bot: UserRow) {
  const { lease } = await claimFor(api, bot);
  return renderTurnPrompt(await loadTurnView(db, lease, bot));
}

describe('set_premoves', () => {
  it('stores a tree holding an illegal opponent move and an illegal reply', async () => {
    const { set, row } = await offerTurn();
    const out = await set(TREE);
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.premoveTree).toEqual(TREE);
    expect((await row()).premoveTree).not.toHaveLength(0);
  });

  it('clears the stored tree with []', async () => {
    const { set, row } = await offerTurn();
    await set(TREE);
    const out = await set([]);
    expect(out.structuredContent!.premoveTree).toEqual([]);
    expect((await row()).premoveTree).toHaveLength(0);
  });

  it('fires a legal reply when the opponent plays its move', async () => {
    const { set, humanMove, game } = await offerTurn();
    await set(TREE);
    await humanMove('e7e5', 1);
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row).toMatchObject({ plyCount: 3, premoveFailure: null });
  });

  it('discards the tree at an illegal reply, and the next move prompt says so', async () => {
    const { bot, set, humanMove, row } = await offerTurn();
    await set(TREE);
    await humanMove('d7d5', 1);
    expect((await row()).premoveTree).toHaveLength(0);
    const prompt = await nextPrompt(bot);
    expect(prompt).toContain(
      'Your premove reply e4e6 to d7d5 was illegal, so your premoves were dropped.',
    );
  });

  describe('depth', () => {
    const line = (n: number): Node[] => {
      let tree: Node[] = [];
      for (let i = 0; i < n; i += 1) tree = [{ move: 'g8f6', reply: 'g1f3', children: tree }];
      return tree;
    };

    it('stores a line 200 pairs deep', async () => {
      const { set } = await offerTurn();
      const out = await set(line(200));
      expect(out.isError).toBeFalsy();
      expect(out.structuredContent!.premoveTree).toEqual(line(200));
    });

    it('refuses a line 201 pairs deep, naming the limit', async () => {
      const { set, row } = await offerTurn();
      const out = await set(line(201));
      expect(out.isError).toBe(true);
      expect(resultText(out)).toContain('at most 200 pairs deep');
      expect((await row()).premoveTree).toHaveLength(0);
    });
  });
});

describe('get_position', () => {
  /** A fresh game with the bot to move, as `colour`. */
  async function onMove(colour: 'white' | 'black') {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, human.id);
    const fresh =
      colour === 'white'
        ? await insertGame(db, group.id, bot.id, human.id)
        : await insertGame(db, group.id, human.id, bot.id);
    const game = colour === 'white' ? fresh : await played(db, fresh, ['e2e4']);
    return { bot, game };
  }

  it('shows the board from black’s side', async () => {
    const { bot } = await onMove('black');
    const { token } = await claimFor(api, bot);
    const view = (await callTool<View>(api.app, token, 'get_position')).structuredContent!;
    expect(view.you).toBe('black');
    expect(view.board.split('\n')[0]).toBe('1 R N B K Q B N R');
  });

  it('shows a standing draw offer from the opponent on a move turn', async () => {
    const { bot, game } = await onMove('white');
    await db
      .update(games)
      .set({ drawOfferBy: 'black', drawOfferPly: 0 })
      .where(eq(games.id, game.id));
    const { token } = await claimFor(api, bot);
    const view = (await callTool<View>(api.app, token, 'get_position')).structuredContent!;
    expect(view).toMatchObject({ yourTurn: true, drawOffer: 'from_opponent' });
  });

  it('includes the PGN only for the detailed format', async () => {
    const { bot } = await onMove('white');
    const { token } = await claimFor(api, bot);
    const plain = (await callTool<View>(api.app, token, 'get_position')).structuredContent!;
    expect(plain.pgn).toBeUndefined();
    const detailed = (await callTool<View>(api.app, token, 'get_position', { format: 'detailed' }))
      .structuredContent!;
    expect(detailed.pgn).toContain('[White "');
  });

  it('does not show a stored tree to the side to move', async () => {
    const { bot, game } = await onMove('white');
    await db
      .update(games)
      .set({
        premoveTree: Buffer.from(encodePremoveBytes([leaf('e7e5', 'g1f3')])),
        premoveTreePly: game.plyCount,
      })
      .where(eq(games.id, game.id));
    const { token } = await claimFor(api, bot);
    const view = (await callTool<View>(api.app, token, 'get_position')).structuredContent!;
    expect(view.yourTurn).toBe(true);
    expect(view.premoveTree).toEqual([]);
  });
});
