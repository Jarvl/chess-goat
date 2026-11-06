import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, users, type UserRow } from '../../src/db/schema';
import { offerDraw } from '../../src/domain/draws';
import { playMove } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
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
import { callTool, openToolCall, resultText, sseMessages, startTestMcp } from '../helpers/mcp';

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

type Entry = Record<string, unknown> & { kind: string };
type Inbox = { entries: Entry[]; more: boolean; waitedSeconds: number };

const inbox = (args: Record<string, unknown> = {}, options = {}) =>
  callTool<Inbox>(api.app, token, 'get_inbox', args, options);

async function setup() {
  const group = await insertGroup(db, { title: 'Chess Club' });
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  return { group, bot, human };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('get_inbox', () => {
  it('shows a challenge to the bot and leaves out one the bot sent', async () => {
    const { group, bot, human } = await setup();
    const incoming = await insertChallenge(db, group.id, human.id, bot.id, {
      challengerColour: 'white',
      timePerMove: 3600,
      rated: false,
    });
    await insertChallenge(db, group.id, bot.id, human.id);
    const out = await inbox();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.entries).toEqual([
      {
        kind: 'challenge',
        bot: { id: bot.id, name: 'Rook' },
        challengeId: incoming.publicId,
        from: { name: '@bob', isBot: false },
        group: { groupId: group.publicId, title: 'Chess Club' },
        timePerMove: 3600,
        rated: false,
        colour: 'black',
        expiresAt: incoming.expiresAt.toISOString(),
      },
    ]);
    expect(out.structuredContent!.waitedSeconds).toBe(0);
    expect(resultText(out)).toContain(incoming.publicId);
  });

  it("shows a game on the bot's move with its ply and deadline", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id);
    const moved = await played(db, game, ['e2e4']);
    // The human's game where the human is to move is not the bot's business.
    await insertGame(db, group.id, human.id, bot.id, { deadlineInSeconds: 60 });
    const out = await inbox({ bot: 'Rook' });
    expect(out.structuredContent!.entries).toEqual([
      {
        kind: 'your_move',
        bot: { id: bot.id, name: 'Rook' },
        gameId: game.publicId,
        opponent: { name: '@bob', isBot: false },
        ply: 1,
        deadlineAt: moved.deadlineAt!.toISOString(),
        drawOffer: 'none',
      },
    ]);
  });

  it("shows a draw offer on the opponent's turn as draw_offer", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, bot.id, human.id);
    await played(db, game, ['e2e4']);
    await offerDraw(api.deps, { gameId: game.publicId, userId: human.id });
    const out = await inbox();
    expect(out.structuredContent!.entries).toEqual([
      {
        kind: 'draw_offer',
        bot: { id: bot.id, name: 'Rook' },
        gameId: game.publicId,
        opponent: { name: '@bob', isBot: false },
        ply: 1,
      },
    ]);
  });

  it("puts an opponent's draw offer on the bot's move into your_move", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id);
    await played(db, game, ['e2e4']);
    await offerDraw(api.deps, { gameId: game.publicId, userId: human.id });
    const out = await inbox();
    expect(out.structuredContent!.entries).toHaveLength(1);
    expect(out.structuredContent!.entries[0]).toMatchObject({
      kind: 'your_move',
      drawOffer: 'from_opponent',
    });
  });

  it('orders by deadline, soonest first and none last, then by age', async () => {
    const { group, bot, human } = await setup();
    const late = await insertGame(db, group.id, bot.id, human.id, { deadlineInSeconds: 7200 });
    const none = await insertGame(db, group.id, bot.id, human.id, { timePerMove: null });
    const soon = await insertGame(db, group.id, bot.id, human.id, { deadlineInSeconds: 600 });
    const challenge = await insertChallenge(db, group.id, human.id, bot.id, {
      expiresInSeconds: 3600,
    });
    const out = await inbox();
    expect(
      out.structuredContent!.entries.map((e) => (e.gameId ?? e.challengeId) as string),
    ).toEqual([soon.publicId, challenge.publicId, late.publicId, none.publicId]);
  });

  it('covers every live bot of the owner without `bot`, and touches each', async () => {
    const { group, bot, human } = await setup();
    const other = await insertBot(db, owner, { firstName: 'Knight' });
    const deleted = await insertBot(db, owner, { firstName: 'Gone', deletedAt: new Date() });
    const stranger = await insertBot(db, human, { firstName: 'Theirs' });
    await insertGame(db, group.id, bot.id, human.id);
    await insertGame(db, group.id, other.id, human.id);
    await insertGame(db, group.id, deleted.id, human.id);
    await insertGame(db, group.id, stranger.id, human.id);
    const all = await inbox();
    expect(
      all.structuredContent!.entries.map((e) => (e.bot as { name: string }).name).sort(),
    ).toEqual(['Knight', 'Rook']);
    const one = await inbox({ bot: 'Knight' });
    expect(one.structuredContent!.entries.map((e) => (e.bot as { name: string }).name)).toEqual([
      'Knight',
    ]);
    const rows = await db.select().from(users);
    const active = (id: number) => rows.find((r) => r.id === id)!.lastActiveAt;
    expect(active(bot.id)).not.toBeNull();
    expect(active(other.id)).not.toBeNull();
    expect(active(stranger.id)).toBeNull();
  });

  it('refuses a wait over 45 seconds', async () => {
    await setup();
    const out = await inbox({ wait_seconds: 46 });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('wait_seconds');
  });

  it('returns within 4 s of a move made 1 s into a 10 s wait', async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id);
    const started = Date.now();
    const waiting = inbox({ wait_seconds: 10 });
    await sleep(1000);
    await playMove(api.deps, {
      gameId: game.publicId,
      userId: human.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'human-1',
    });
    const out = await waiting;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.structuredContent!.entries).toMatchObject([
      { kind: 'your_move', gameId: game.publicId, ply: 1 },
    ]);
    expect(out.structuredContent!.waitedSeconds).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty inbox when a 3 s wait runs out', async () => {
    await setup();
    const started = Date.now();
    const out = await inbox({ wait_seconds: 3 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
    expect(out.structuredContent).toEqual({ entries: [], more: false, waitedSeconds: 3 });
  });

  it('sends progress every 5 s while waiting, from within the first 5 s', async () => {
    await setup();
    const started = Date.now();
    const res = await openToolCall(
      api.app,
      token,
      'get_inbox',
      { wait_seconds: 12 },
      { progressToken: 'p1' },
    );
    const progressAt: number[] = [];
    let result: Inbox | undefined;
    for await (const message of sseMessages(res)) {
      if (message.method === 'notifications/progress') {
        expect(message.params).toMatchObject({ progressToken: 'p1' });
        progressAt.push(Date.now() - started);
      } else if (message.result) {
        result = message.result.structuredContent as Inbox;
      }
    }
    expect(progressAt.length).toBeGreaterThanOrEqual(2);
    expect(progressAt[0]).toBeLessThanOrEqual(5500);
    expect(result).toEqual({ entries: [], more: false, waitedSeconds: 12 });
  }, 20_000);

  it('refuses a third concurrent wait', async () => {
    await setup();
    const first = inbox({ wait_seconds: 3 });
    const second = inbox({ wait_seconds: 3 });
    await sleep(300);
    const third = await inbox({ wait_seconds: 3 });
    expect(third.isError).toBe(true);
    expect(resultText(third)).toContain('You already have 2 inbox waits open.');
    expect((await first).isError).toBeFalsy();
    expect((await second).isError).toBeFalsy();
    // A read without waiting is never refused.
    const [a, b] = [inbox({ wait_seconds: 2 }), inbox({ wait_seconds: 2 })];
    await sleep(300);
    expect((await inbox()).isError).toBeFalsy();
    await Promise.all([a, b]);
  });

  it('ends the wait when the HTTP request is aborted', async () => {
    await setup();
    const abort = new AbortController();
    const res = await openToolCall(
      api.app,
      token,
      'get_inbox',
      { wait_seconds: 45 },
      { signal: abort.signal },
    );
    await sleep(500);
    abort.abort();
    await res.body?.cancel().catch(() => {});
    await sleep(300);
    // Had the aborted wait lived on, it would hold one of the two slots.
    const [a, b] = await Promise.all([inbox({ wait_seconds: 1 }), inbox({ wait_seconds: 1 })]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
  });

  it('does not touch a game that has ended', async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, bot.id, human.id);
    await db.update(games).set({ status: 'finished' }).where(eq(games.id, game.id));
    expect((await inbox()).structuredContent!.entries).toEqual([]);
  });

  it('returns 50 entries and more when 60 games wait', async () => {
    const { group, bot, human } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const game = await insertGame(db, group.id, bot.id, human.id, {
        deadlineInSeconds: 600 + i,
      });
      ids.push(game.publicId);
    }
    const out = await inbox();
    expect(out.structuredContent!.entries).toHaveLength(50);
    expect(out.structuredContent!.more).toBe(true);
    // The soonest 50.
    expect(out.structuredContent!.entries.map((e) => e.gameId)).toEqual(ids.slice(0, 50));
    expect(resultText(out)).toContain('There are more; act on these, then call get_inbox again.');
    const few = await inbox({ bot: 'Rook' });
    expect(few.structuredContent!.more).toBe(true);
  });

  it('says more is false with fewer than 50', async () => {
    const { group, bot, human } = await setup();
    await insertGame(db, group.id, bot.id, human.id);
    const out = await inbox();
    expect(out.structuredContent!.more).toBe(false);
    expect(resultText(out)).not.toContain('There are more');
  });

  it('reads whose turn it is from the position, not the ply', async () => {
    const { group, bot, human } = await setup();
    // Black to move at ply 0: a game set up from a position.
    const game = await insertGame(db, group.id, human.id, bot.id, {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    const out = await inbox();
    expect(out.structuredContent!.entries).toMatchObject([
      { kind: 'your_move', gameId: game.publicId, ply: 0 },
    ]);
  });

  it('answers a third concurrent call at once when it has entries', async () => {
    const { group, bot, human } = await setup();
    await insertBot(db, owner, { firstName: 'Knight' });
    await insertGame(db, group.id, bot.id, human.id);
    const first = inbox({ bot: 'Knight', wait_seconds: 3 });
    const second = inbox({ bot: 'Knight', wait_seconds: 3 });
    await sleep(300);
    const started = Date.now();
    const third = await inbox({ bot: 'Rook', wait_seconds: 3 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(third.isError).toBeFalsy();
    expect(third.structuredContent!.entries).toHaveLength(1);
    await Promise.all([first, second]);
  });

  it('returns at once with no bots, saying to create one', async () => {
    const started = Date.now();
    const out = await inbox({ wait_seconds: 10 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({ entries: [], more: false, waitedSeconds: 0 });
    expect(resultText(out)).toBe('You have no bots yet. Call create_bot.');
  });
});
