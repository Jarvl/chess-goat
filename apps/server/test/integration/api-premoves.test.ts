import {
  GameDtoSchema,
  countPremovePairs,
  decodePremoveBytes,
  encodePremoveBytes,
  encodePremoveTree,
  premoveTreeHash,
  type PremoveNode,
} from '@group-chess/shared';
import { Chess, type Move } from 'chess.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { games } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.membership.clearCaches();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

async function world() {
  const group = await insertGroup(db, { telegramChatId: -1001000000004 });
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  const carol = await insertUser(db, { telegramUserId: 33, firstName: 'Carol' });
  for (const user of [alice, bob, carol])
    await touchMember(db, group.id, user.id, { verified: true });
  // Alice is White and to move; Bob premoves.
  const game = await insertGame(db, group.id, alice.id, bob.id);
  const tokens = {
    alice: await api.sessionFor(alice),
    bob: await api.sessionFor(bob),
    carol: await api.sessionFor(carol),
  };
  return { group, alice, bob, carol, game, tokens };
}

const put = (token: string, gameId: string, body: unknown) =>
  api.request('PUT', `/api/games/${gameId}/premoves`, { token, body });
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
const stored = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;
const enc = encodePremoveTree;
const hash = (tree: PremoveNode[]) => premoveTreeHash(encodePremoveBytes(tree));
const body = async (base: PremoveNode[], tree: PremoveNode[], expectedPly = 0) => ({
  baseHash: await hash(base),
  tree: enc(tree),
  expectedPly,
});

// Bob (Black) owns the tree: its branches are White moves, its replies Black moves.
const e4e5: PremoveNode[] = [{ move: 'e2e4', reply: 'e7e5', children: [] }];
const d4d5: PremoveNode[] = [{ move: 'd2d4', reply: 'd7d5', children: [] }];

const uciOf = (move: Move) => move.from + move.to + (move.promotion ?? '');

/**
 * A legal tree of exactly `pairs` pairs from the initial position, the same on every run: every
 * opponent move but the last at the root (that one is left free for a new branch), 5 below each,
 * 3 below each of those, then one long line under each node of the third level.
 */
function bigTree(pairs: number): PremoveNode[] {
  let seed = 7;
  const pick = <T>(list: readonly T[]): T => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return list[seed % list.length] as T;
  };
  let count = 0;
  /** Plays `san` and a seeded reply on `chess` and returns the pair; null, undone, when no reply. */
  const pair = (chess: Chess, san: string): PremoveNode | null => {
    const move = chess.move(san);
    const replies = chess.moves();
    if (replies.length === 0) {
      chess.undo();
      return null;
    }
    count += 1;
    return { move: uciOf(move), reply: uciOf(chess.move(pick(replies))), children: [] };
  };
  type Spot = { node: PremoveNode; fen: string };
  const branches = (fen: string, width: number): Spot[] => {
    const spots: Spot[] = [];
    const chess = new Chess(fen);
    for (const san of chess.moves()) {
      if (spots.length === width) break;
      const node = pair(chess, san);
      if (!node) continue;
      spots.push({ node, fen: chess.fen() });
      chess.undo();
      chess.undo();
    }
    return spots;
  };
  const root = branches(new Chess().fen(), new Chess().moves().length - 1);
  let level = root;
  for (const width of [5, 3]) {
    level = level.flatMap((spot) => {
      const below = branches(spot.fen, width);
      spot.node.children.push(...below.map((child) => child.node));
      return below;
    });
  }
  for (const [index, spot] of level.entries()) {
    // A line that runs into mate or stalemate leaves its share to the lines after it.
    const chess = new Chess(spot.fen);
    let parent = spot.node;
    const end = count + Math.ceil((pairs - count) / (level.length - index));
    while (count < end) {
      const moves = chess.moves();
      const node = moves.length > 0 ? pair(chess, pick(moves)) : null;
      if (!node) break;
      parent.children.push(node);
      parent = node;
    }
  }
  return root.map((spot) => spot.node);
}

describe('PUT /api/games/:id/premoves', () => {
  it('saves, replaces and clears the tree without bumping the version', async () => {
    const { game, tokens } = await world();
    let res = await put(tokens.bob, game.publicId, await body([], e4e5));
    expect(res.status).toBe(200);
    expect(GameDtoSchema.parse(await res.json()).premoveTree).toBe(enc(e4e5));
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(e4e5);
    expect((await stored(game.id)).version).toBe(0);
    const both = [...e4e5, ...d4d5];
    res = await put(tokens.bob, game.publicId, await body(e4e5, both));
    expect(res.status).toBe(200);
    expect(GameDtoSchema.parse(await res.json()).premoveTree).toBe(enc(both));
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(both);
    res = await put(tokens.bob, game.publicId, { ...(await body(both, [])), tree: '' });
    expect(res.status).toBe(200);
    expect(GameDtoSchema.parse(await res.json()).premoveTree).toBe('');
    const after = await stored(game.id);
    expect(after.premoveTree).toHaveLength(0);
    expect(after.version).toBe(0);
  });

  it('refuses the player to move, a stale ply, a stale fingerprint, a malformed tree and an illegal move', async () => {
    const { game, tokens } = await world();
    expect(await errorCode(await put(tokens.alice, game.publicId, await body([], e4e5)))).toBe(
      'not_your_turn',
    );
    expect(await errorCode(await put(tokens.bob, game.publicId, await body([], e4e5, 3)))).toBe(
      'stale_state',
    );
    await put(tokens.bob, game.publicId, await body([], e4e5));
    // Another device already saved e4 e5; this one still shows an empty tree.
    const stale = await put(tokens.bob, game.publicId, await body([], d4d5));
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('stale_state');
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(e4e5);
    // One pair cut short: a move with no reply.
    const truncated = enc(e4e5).slice(0, 4);
    expect(
      await errorCode(
        await put(tokens.bob, game.publicId, { ...(await body(e4e5, [])), tree: truncated }),
      ),
    ).toBe('validation');
    const illegal = [...e4e5, { move: 'd2d4', reply: 'd7d4', children: [] }];
    expect(await errorCode(await put(tokens.bob, game.publicId, await body(e4e5, illegal)))).toBe(
      'illegal_move',
    );
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(e4e5);
  });

  it('checks only nodes not already stored', async () => {
    const { game, tokens } = await world();
    // A stored pair that is not legal. Stored pairs were checked when they were saved; this one
    // stands in for that, to show it is not checked again.
    const bad: PremoveNode[] = [{ move: 'e2e4', reply: 'e7e4', children: [] }];
    await db
      .update(games)
      .set({ premoveTree: Buffer.from(encodePremoveBytes(bad)) })
      .where(eq(games.id, game.id));
    const added = [...bad, ...d4d5];
    const res = await put(tokens.bob, game.publicId, await body(bad, added));
    expect(res.status).toBe(200);
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(added);
    // A new node is still checked.
    const worse = [...added, { move: 'c2c4', reply: 'c7c4', children: [] }];
    expect(await errorCode(await put(tokens.bob, game.publicId, await body(added, worse)))).toBe(
      'illegal_move',
    );
  });

  it('saves and edits a 9,000-pair tree', async () => {
    const { game, tokens } = await world();
    const tree = bigTree(9_000);
    expect(countPremovePairs(tree)).toBe(9_000);
    const first = await body([], tree);
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(64 * 1024);
    expect((await put(tokens.bob, game.publicId, first)).status).toBe(200);
    // The root's last opponent move was left free.
    const chess = new Chess();
    const free = chess.moves({ verbose: true }).at(-1)!;
    chess.move(free);
    const extra = {
      move: uciOf(free),
      reply: uciOf(chess.moves({ verbose: true })[0]!),
      children: [],
    };
    const edited = [...tree, extra];
    const second = await body(tree, edited);
    expect(new TextEncoder().encode(JSON.stringify(second)).length).toBeLessThan(64 * 1024);
    expect((await put(tokens.bob, game.publicId, second)).status).toBe(200);
    expect(decodePremoveBytes((await stored(game.id)).premoveTree)).toEqual(edited);
  });

  it('refuses spectators and finished games', async () => {
    const { game, tokens } = await world();
    expect((await put(tokens.carol, game.publicId, await body([], e4e5))).status).toBe(403);
    await api.request('POST', `/api/games/${game.publicId}/resign`, { token: tokens.alice });
    expect(await errorCode(await put(tokens.bob, game.publicId, await body([], e4e5)))).toBe(
      'stale_state',
    );
  });

  it('pushes an edit to the owner’s streams only, and publishes nothing for a no-op', async () => {
    const { game, bob, tokens } = await world();
    const heard: unknown[] = [];
    api.deps.bus.subscribe(game.publicId, (audience) => heard.push(audience));
    await put(tokens.bob, game.publicId, await body([], e4e5));
    expect((await put(tokens.bob, game.publicId, await body(e4e5, e4e5))).status).toBe(200);
    expect(heard).toEqual([{ userId: bob.id }]);
  });

  it('gives a reconnecting device the current tree even with a current Last-Event-ID', async () => {
    const { game, tokens } = await world();
    const firstState = async (headers: Record<string, string> = {}) => {
      const controller = new AbortController();
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.bob}`,
        {
          signal: controller.signal,
          headers,
        },
      );
      const reader = res.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return chunk;
    };
    await put(tokens.bob, game.publicId, await body([], e4e5));
    expect(await firstState({ 'last-event-id': '0' })).toContain(`"premoveTree":"${enc(e4e5)}"`);
  });

  it('delivers an owner-only push that lands while the first snapshot is being read', async () => {
    const { game, bob, tokens } = await world();
    // Fire the push at the exact moment the stream first reaches for the database after opening:
    // the snapshot's DTO read. Arming on the stream gauge keeps the auth and access reads out of it.
    const realDb = api.deps.db;
    let armed = false;
    const gauge = api.ctx.metrics.sseStreams;
    const inc = gauge.inc.bind(gauge);
    const spy = vi.spyOn(gauge, 'inc').mockImplementation((...args) => {
      armed = true;
      inc(...args);
    });
    Object.defineProperty(api.deps, 'db', {
      configurable: true,
      get: () => {
        if (armed) {
          armed = false;
          api.deps.bus.publish(game.publicId, { userId: bob.id });
        }
        return realDb;
      },
    });
    const controller = new AbortController();
    try {
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.bob}`,
        { signal: controller.signal },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      // A lost push leaves this waiting for a second state that never comes (the test times out).
      while (received.split('event: state').length - 1 < 2)
        received += decoder.decode((await reader.read()).value);
      expect(armed).toBe(false);
      expect(received.split('event: state').length - 1).toBe(2);
    } finally {
      controller.abort();
      spy.mockRestore();
      Object.defineProperty(api.deps, 'db', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: realDb,
      });
    }
  }, 3_000);
});
