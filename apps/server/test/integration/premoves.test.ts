import {
  INITIAL_FEN,
  decodePremoveBytes,
  encodePremoveBytes,
  encodePremoveTree,
  premoveTreeHash,
  type PremoveNode,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dmMessages, games, jobs, moves } from '../../src/db/schema';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { getGameDto, playMove, requireGameById, resign } from '../../src/domain/games';
import { DomainError } from '../../src/domain/errors';
import { touchMember } from '../../src/domain/members';
import { checkTreeYielding, setPremoveTree } from '../../src/domain/premoves';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

let counter = 0;
const move = (
  gameId: string,
  userId: number,
  uci: string,
  expectedPly: number,
  tree?: PremoveNode[],
) =>
  playMove(deps, {
    gameId,
    userId,
    uci,
    expectedPly,
    clientMoveId: `c-${(counter += 1)}`,
    premoveTree: encodePremoveTree(tree ?? []),
  });
const jobList = async () =>
  (await db.select().from(jobs).orderBy(jobs.id)).map((job) => [job.kind, job.dedupKey]);

async function setup(overrides: GameOverrides = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, carol, game };
}

describe('premove storage and visibility', () => {
  // White (Alice) to move; Black (Bob) owns the tree.
  const e4e5: PremoveNode[] = [{ move: 'e2e4', reply: 'e7e5', children: [] }];
  const bytesOf = (tree: PremoveNode[]) => Buffer.from(encodePremoveBytes(tree));

  it('shows the tree to its owner only, and only while it is not their turn', async () => {
    const { game, alice, bob, carol } = await setup({ premoveTree: bytesOf(e4e5) });
    const treeFor = async (viewerUserId: number | null) =>
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId })).premoveTree;
    expect(await treeFor(bob.id)).toBe(encodePremoveTree(e4e5));
    expect(await treeFor(alice.id)).toBe('');
    expect(await treeFor(carol.id)).toBe('');
    expect(await treeFor(null)).toBe('');
  });

  it('empties the tree when the game ends', async () => {
    const { game, alice } = await setup({ premoveTree: bytesOf(e4e5) });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    expect((await requireGameById(db, game.id)).premoveTree).toHaveLength(0);
  });

  it('refuses a lone zero count: the empty tree is no bytes', async () => {
    const { game, bob } = await setup();
    const saved = setPremoveTree(deps, {
      gameId: game.publicId,
      userId: bob.id,
      baseHash: await premoveTreeHash(new Uint8Array()),
      tree: 'AA',
      expectedPly: 0,
    });
    await expect(saved).rejects.toMatchObject({ code: 'validation' });
  });

  it('reports why it refused', async () => {
    const { game, bob } = await setup();
    const refusal = async (input: {
      baseHash?: string;
      tree: PremoveNode[];
      expectedPly?: number;
    }) =>
      setPremoveTree(deps, {
        gameId: game.publicId,
        userId: bob.id,
        baseHash: input.baseHash ?? (await premoveTreeHash(new Uint8Array())),
        tree: encodePremoveTree(input.tree),
        expectedPly: input.expectedPly ?? 0,
      }).then(
        () => null,
        (error: unknown) => (error instanceof DomainError ? error : null),
      );
    expect(await refusal({ tree: e4e5, expectedPly: 2 })).toMatchObject({
      code: 'stale_state',
      details: { plyCount: 0 },
    });
    expect(
      await refusal({ tree: e4e5, baseHash: await premoveTreeHash(encodePremoveBytes(e4e5)) }),
    ).toMatchObject({ code: 'stale_state', details: { reason: 'premoves_changed' } });
    expect(await refusal({ tree: [{ move: 'e2e4', reply: 'e7e4', children: [] }] })).toMatchObject({
      code: 'illegal_move',
      details: { path: ['e2e4', 'e7e4'] },
    });
  });
});

describe('checkTreeYielding', () => {
  it('gives the event loop a turn between slices and returns the check', async () => {
    const lines: PremoveNode[] = [
      { move: 'e2e4', reply: 'e7e5', children: [{ move: 'g1f3', reply: 'b8c6', children: [] }] },
      { move: 'd2d4', reply: 'd7d5', children: [] },
    ];
    // Without a yield the whole check settles in microtasks, before any immediate callback.
    let otherWork = false;
    setImmediate(() => (otherWork = true));
    expect(await checkTreeYielding(INITIAL_FEN, lines, [], 1)).toEqual({ ok: true });
    expect(otherWork).toBe(true);
    expect(
      await checkTreeYielding(INITIAL_FEN, [{ move: 'e2e4', reply: 'e7e4', children: [] }], []),
    ).toEqual({ ok: false, path: ['e2e4', 'e7e4'] });
  });
});

const storeTree = (id: number, tree: PremoveNode[]) =>
  db
    .update(games)
    .set({ premoveTree: Buffer.from(encodePremoveBytes(tree)) })
    .where(eq(games.id, id));
const storedTree = async (id: number) =>
  decodePremoveBytes((await requireGameById(db, id)).premoveTree);
const moveRows = (gameId: number) =>
  db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(moves.ply);
const dmJobs = async () =>
  (await db.select().from(jobs).orderBy(jobs.id)).filter((job) => job.kind === 'send_dm');
const refusal = (attempt: Promise<unknown>) =>
  attempt.then(
    () => null,
    (error: unknown) => (error instanceof DomainError ? error : null),
  );

describe('firing premoves', () => {
  // White (Alice) to move; Black (Bob) owns the stored tree.
  const bobsLine: PremoveNode[] = [
    { move: 'e2e4', reply: 'e7e5', children: [{ move: 'g1f3', reply: 'b8c6', children: [] }] },
  ];

  it('plays the matching reply and keeps its subtree', async () => {
    const { game, alice } = await setup();
    await storeTree(game.id, bobsLine);
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({ plyCount: 2, version: 2 });
    expect(dto.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect((await moveRows(game.id)).map((m) => m.clientMoveId)[1]).toBe(
      `premove:${game.publicId}:2`,
    );
    expect(await storedTree(game.id)).toEqual(bobsLine[0]!.children);
    expect(await jobList()).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${alice.id}:g:${game.publicId}`],
    ]);
  });

  it("marks the tree owner's DM as waiting and sends them no turn DM", async () => {
    const { game, alice, bob } = await setup();
    await db.insert(dmMessages).values({
      userId: bob.id,
      chatId: 22,
      gameId: game.id,
      telegramMessageId: 101,
      kind: 'turn',
      stub: 'Game vs Alice ended',
      sentAt: new Date(),
    });
    await storeTree(game.id, bobsLine);
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect(await db.select().from(dmMessages)).toMatchObject([
      { userId: bob.id, kind: 'waiting', stub: '✓ You played 1... e5 · waiting for Alice' },
    ]);
    expect((await dmJobs()).map((job) => job.payload.userId)).toEqual([alice.id]);
  });

  it("clears a missed tree and flags the owner's turn DM", async () => {
    const { game, alice, bob } = await setup();
    await storeTree(game.id, bobsLine);
    const dto = await move(game.publicId, alice.id, 'd2d4', 0);
    expect(dto.plyCount).toBe(1);
    expect((await requireGameById(db, game.id)).premoveTree).toHaveLength(0);
    const dms = await dmJobs();
    expect(dms.map((job) => job.dedupKey)).toEqual([`dm:${bob.id}:g:${game.publicId}`]);
    expect(dms[0]?.payload).toEqual({
      userId: bob.id,
      template: 'turn',
      gameId: game.id,
      premovesCancelledAtPly: 1,
    });
  });

  it('sends no flag when the line runs out', async () => {
    const { game, alice } = await setup();
    await storeTree(game.id, [{ move: 'e2e4', reply: 'e7e5', children: [] }]);
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto.plyCount).toBe(2);
    expect((await requireGameById(db, game.id)).premoveTree).toHaveLength(0);
    expect((await dmJobs()).map((job) => job.payload)).toEqual([
      { userId: alice.id, template: 'turn', gameId: game.id },
    ]);
  });

  it('stores the mover’s tree with their move', async () => {
    const { game, alice, bob } = await setup();
    const alicesTree: PremoveNode[] = [{ move: 'e7e5', reply: 'g1f3', children: [] }];
    const dto = await move(game.publicId, alice.id, 'e2e4', 0, alicesTree);
    expect(dto).toMatchObject({ plyCount: 1, premoveTree: encodePremoveTree(alicesTree) });
    expect(await storedTree(game.id)).toEqual(alicesTree);
    expect((await dmJobs()).map((job) => job.payload)).toEqual([
      { userId: bob.id, template: 'turn', gameId: game.id },
    ]);
  });

  it('plays alternating trees until one misses', async () => {
    const { game, alice, bob } = await setup();
    await storeTree(game.id, bobsLine);
    const alicesTree: PremoveNode[] = [
      {
        move: 'e7e5',
        reply: 'g1f3',
        children: [
          {
            move: 'b8c6',
            reply: 'f1b5',
            children: [{ move: 'a7a6', reply: 'b5a4', children: [] }],
          },
        ],
      },
    ];
    const dto = await move(game.publicId, alice.id, 'e2e4', 0, alicesTree);
    expect(dto.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(dto).toMatchObject({ plyCount: 5, version: 5 });
    expect((await moveRows(game.id)).map((m) => m.clientMoveId).slice(1)).toEqual(
      [2, 3, 4, 5].map((ply) => `premove:${game.publicId}:${ply}`),
    );
    // Black is to move, so the stored tree is White's: what is left of Alice's line.
    expect(await storedTree(game.id)).toEqual([{ move: 'a7a6', reply: 'b5a4', children: [] }]);
    expect(await jobList()).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}`],
    ]);
    expect((await dmJobs())[0]?.payload).toEqual({
      userId: bob.id,
      template: 'turn',
      gameId: game.id,
    });
  });

  it('finishes the game when a fired reply mates', async () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5, Black to move; Alice answers Nf6 with Qxf7#.
    const { game, bob } = await setup({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
      plyCount: 5,
      premoveTree: Buffer.from(encodePremoveBytes([{ move: 'g8f6', reply: 'h5f7', children: [] }])),
    });
    const dto = await move(game.publicId, bob.id, 'g8f6', 5, [
      { move: 'd2d3', reply: 'd7d6', children: [] },
    ]);
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'checkmate' });
    expect(dto.moves.map((m) => m.san)).toEqual(['Nf6', 'Qxf7#']);
    expect((await requireGameById(db, game.id)).premoveTree).toHaveLength(0);
  });

  it('fires a promoting reply', async () => {
    const { game, bob } = await setup({
      fen: '4k3/1P6/8/8/8/8/8/4K3 b - - 0 40',
      plyCount: 79,
      premoveTree: Buffer.from(
        encodePremoveBytes([{ move: 'e8d7', reply: 'b7b8q', children: [] }]),
      ),
    });
    const dto = await move(game.publicId, bob.id, 'e8d7', 79);
    expect(dto.moves.map((m) => m.san)).toEqual(['Kd7', 'b8=Q']);
    expect(dto.plyCount).toBe(81);
  });

  it('refuses a move whose tree is illegal, and plays nothing', async () => {
    const { game, alice } = await setup();
    const error = await refusal(
      move(game.publicId, alice.id, 'e2e4', 0, [{ move: 'e7e5', reply: 'e1e3', children: [] }]),
    );
    expect(error).toMatchObject({ code: 'illegal_move', details: { path: ['e7e5', 'e1e3'] } });
    expect((await requireGameById(db, game.id)).plyCount).toBe(0);
    expect(await moveRows(game.id)).toEqual([]);
  });

  it('reports a malformed tree only after the game, ply and turn checks', async () => {
    const { game, alice, bob, carol } = await setup();
    const send = (userId: number, expectedPly: number, premoveTree: string) =>
      refusal(
        playMove(deps, {
          gameId: game.publicId,
          userId,
          uci: 'e2e4',
          expectedPly,
          clientMoveId: `c-${(counter += 1)}`,
          premoveTree,
        }),
      );
    expect(await send(carol.id, 0, 'AA')).toMatchObject({ code: 'forbidden' });
    expect(await send(alice.id, 3, 'AA')).toMatchObject({ code: 'stale_state' });
    expect(await send(bob.id, 0, 'AA')).toMatchObject({ code: 'not_your_turn' });
    expect(await send(alice.id, 0, 'AA')).toMatchObject({ code: 'validation' });
    expect(await send(alice.id, 0, '!')).toMatchObject({ code: 'validation' });
    expect((await requireGameById(db, game.id)).plyCount).toBe(0);
  });

  it('returns the current state for a retried move with a tree', async () => {
    const { game, alice } = await setup();
    const alicesTree: PremoveNode[] = [{ move: 'e7e5', reply: 'g1f3', children: [] }];
    const input = {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'retry-me',
    };
    await playMove(deps, { ...input, premoveTree: encodePremoveTree(alicesTree) });
    const retried = await playMove(deps, {
      ...input,
      premoveTree: encodePremoveTree([{ move: 'd7d5', reply: 'e4d5', children: [] }]),
    });
    expect(retried).toMatchObject({ plyCount: 1, premoveTree: encodePremoveTree(alicesTree) });
    expect(await storedTree(game.id)).toEqual(alicesTree);
    // Neither checked nor stored: a retry is answered before the tree is looked at.
    expect((await playMove(deps, { ...input, premoveTree: 'AA' })).plyCount).toBe(1);
    expect(await storedTree(game.id)).toEqual(alicesTree);
  });

  it('returns the current state for a retried move after its premove reply was played', async () => {
    const { game, alice } = await setup();
    await storeTree(game.id, bobsLine);
    const input = {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'retry-me',
    };
    await playMove(deps, input);
    expect((await playMove(deps, input)).plyCount).toBe(2);
  });

  it('cancels a bot game tree with no send_dm job, since bot games announce nothing', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { firstName: 'Alice' });
    await touchMember(db, group.id, alice.id);
    const engine = await getEngineUser(db);
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    // Alice expects 1...d5 and has 2.exd5 ready; the engine plays 1...e5 instead.
    await move(game.publicId, alice.id, 'e2e4', 0, [{ move: 'd7d5', reply: 'e4d5', children: [] }]);
    await move(game.publicId, engine.id, 'e7e5', 1);
    expect((await requireGameById(db, game.id)).premoveTree).toHaveLength(0);
    expect(await dmJobs()).toEqual([]);
  });
});
