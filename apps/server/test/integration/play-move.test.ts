import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, moves } from '../../src/db/schema';
import { playMove, requireGameById, type PlayMoveInput } from '../../src/domain/games';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

/**
 * `playMove` itself: the one move path for people, the engine and bots. Each case here was once
 * checked only by the MCP make_move tool over JSON-RPC.
 */
const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup(fen?: string) {
  const group = await insertGroup(db);
  const owner = await insertUser(db);
  const bot = await insertBot(db, owner);
  const human = await insertUser(db);
  const game = await insertGame(db, group.id, bot.id, human.id, fen ? { fen } : {});
  const move = (over: Partial<PlayMoveInput>) =>
    playMove(deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0, ...over });
  return { bot, human, game, move };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: { code: string; details: Record<string, unknown> }) => e,
  );

const moveRows = async (gameId: number) =>
  db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(moves.ply);

describe('playMove', () => {
  it('takes SAN or UCI', async () => {
    const { game, human, move } = await setup();
    expect((await move({ move: 'e4' })).outcome).toBe('played');
    await playMove(deps, { gameId: game.publicId, userId: human.id, move: 'e7e5', expectedPly: 1 });
    await move({ move: 'g1f3', expectedPly: 2 });
    expect((await moveRows(game.id)).map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('sees a retry without a client move id: same player, same move, same ply', async () => {
    const { game, move } = await setup();
    await move({ move: 'e4' });
    const again = await move({ move: 'e2e4' });
    expect(again.outcome).toBe('retry');
    expect(again.game.plyCount).toBe(1);
    expect(await moveRows(game.id)).toHaveLength(1);
  });

  it('sees a retry even once the game is over', async () => {
    const { game, move } = await setup();
    await move({ move: 'e4' });
    await db.update(games).set({ status: 'finished', result: '0-1' }).where(eq(games.id, game.id));
    expect((await move({ move: 'e4' })).outcome).toBe('retry');
  });

  it('honours a client move id as a retry too', async () => {
    const { move } = await setup();
    await move({ move: 'e4', clientMoveId: 'abc12345' });
    expect((await move({ move: 'd4', clientMoveId: 'abc12345' })).outcome).toBe('retry');
  });

  it('refuses a different move at an old ply as stale, with the current ply', async () => {
    const { move } = await setup();
    await move({ move: 'e4' });
    expect(await refusal(move({ move: 'd4' }))).toMatchObject({
      code: 'stale_state',
      details: { plyCount: 1 },
    });
  });

  it("refuses a move on the opponent's turn", async () => {
    const { game, human } = await setup();
    const out = await refusal(
      playMove(deps, { gameId: game.publicId, userId: human.id, move: 'e5', expectedPly: 0 }),
    );
    expect(out.code).toBe('not_your_turn');
  });

  it('refuses an illegal move with the legal ones, at most 30', async () => {
    const { move } = await setup();
    const out = await refusal(move({ move: 'Ke5' }));
    expect(out).toMatchObject({ code: 'illegal_move', details: { move: 'Ke5' } });
    expect(out.details.legal).toContain('Nf3 (g1f3)');
    expect(String(out.details.legal).match(/\(/g)).toHaveLength(20);
    const crowded = await setup('R6R/3Q4/1Q4Q1/4Q3/2Q4Q/Q4Q2/pp1Q4/kBNN1KB1 w - - 0 1');
    const many = await refusal(crowded.move({ move: 'Zz9' }));
    expect(String(many.details.legal).match(/\(/g)).toHaveLength(30);
  });

  it('refuses a finished game, at the current ply or a later one', async () => {
    const { game, move } = await setup();
    await db.update(games).set({ status: 'finished', result: '0-1' }).where(eq(games.id, game.id));
    for (const expectedPly of [0, 3]) {
      expect(await refusal(move({ expectedPly }))).toMatchObject({
        code: 'stale_state',
        details: { reason: 'game_over' },
      });
    }
  });

  it('refuses someone who does not play in the game, and a game that does not exist', async () => {
    const { game } = await setup();
    const stranger = await insertUser(db);
    expect(
      await refusal(
        playMove(deps, { gameId: game.publicId, userId: stranger.id, move: 'e4', expectedPly: 0 }),
      ),
    ).toMatchObject({ code: 'forbidden', details: { reason: 'not_a_player' } });
    expect(
      await refusal(
        playMove(deps, { gameId: 'nope', userId: stranger.id, move: 'e4', expectedPly: 0 }),
      ),
    ).toMatchObject({ code: 'not_found', details: { reason: 'game_not_found' } });
  });

  it("'record' keeps a tree whose lines are not checked; 'reject' refuses an illegal one", async () => {
    const illegal = [{ move: 'e7e5', reply: 'e1e8', children: [] }];
    const bot = await setup();
    await bot.move({ premoves: { tree: illegal, ifIllegal: 'record' } });
    expect((await requireGameById(db, bot.game.id)).premoveTree.length).toBeGreaterThan(0);

    const person = await setup();
    const out = await refusal(person.move({ premoves: { tree: illegal, ifIllegal: 'reject' } }));
    expect(out).toMatchObject({ code: 'illegal_move', details: { path: ['e7e5', 'e1e8'] } });
    expect((await requireGameById(db, person.game.id)).plyCount).toBe(0);
  });
});
