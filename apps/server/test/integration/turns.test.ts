import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { pendingTurns, sameTurn } from '../../src/domain/turns';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
  played,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
beforeEach(() => truncateAll(db));
afterAll(close);

async function setup() {
  const group = await insertGroup(db);
  const owner = await insertUser(db);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db);
  return { group, bot, human };
}

describe('pendingTurns', () => {
  it('is empty for no bots', async () => {
    expect(await pendingTurns(db, [])).toEqual([]);
  });

  it('turns a pending challenge to the bot into a challenge turn, not one it sent', async () => {
    const { group, bot, human } = await setup();
    const incoming = await insertChallenge(db, group.id, human.id, bot.id);
    await insertChallenge(db, group.id, bot.id, human.id);
    expect(await pendingTurns(db, [bot.id])).toEqual([
      {
        botId: bot.id,
        kind: 'challenge',
        gameId: null,
        challengeId: incoming.id,
        ply: null,
        deadlineAt: incoming.expiresAt,
        since: incoming.createdAt,
      },
    ]);
  });

  it('leaves out expired and answered challenges', async () => {
    const { group, bot, human } = await setup();
    await insertChallenge(db, group.id, human.id, bot.id, { expiresInSeconds: -60 });
    await insertChallenge(db, group.id, human.id, bot.id, { status: 'declined' });
    expect(await pendingTurns(db, [bot.id])).toEqual([]);
  });

  it("turns an active game on the bot's move into a move turn at its ply", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id);
    const moved = await played(db, game, ['e2e4']);
    // The human to move is not the bot's business.
    await insertGame(db, group.id, human.id, bot.id);
    expect(await pendingTurns(db, [bot.id])).toEqual([
      {
        botId: bot.id,
        kind: 'move',
        gameId: game.id,
        challengeId: null,
        ply: 1,
        deadlineAt: moved.deadlineAt,
        since: moved.lastMoveAt ?? moved.startedAt,
      },
    ]);
  });

  it('leaves out finished games', async () => {
    const { group, bot, human } = await setup();
    await insertGame(db, group.id, bot.id, human.id, { status: 'finished' });
    expect(await pendingTurns(db, [bot.id])).toEqual([]);
  });

  it("turns an opponent's draw offer on the opponent's move into a draw_offer turn", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, bot.id, human.id);
    await played(db, game, ['e2e4']);
    // The bot is white; its own offer needs no answer.
    await db.update(games).set({ drawOfferBy: 'white' }).where(eq(games.id, game.id));
    expect(await pendingTurns(db, [bot.id])).toEqual([]);
    await db.update(games).set({ drawOfferBy: 'black' }).where(eq(games.id, game.id));
    expect(await pendingTurns(db, [bot.id])).toMatchObject([
      { kind: 'draw_offer', gameId: game.id, challengeId: null, ply: 1, deadlineAt: null },
    ]);
  });

  it("a draw offer on the bot's own move yields one move turn, not two", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id);
    await played(db, game, ['e2e4']);
    await db.update(games).set({ drawOfferBy: 'white' }).where(eq(games.id, game.id));
    const turns = await pendingTurns(db, [bot.id]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: 'move', gameId: game.id, ply: 1 });
  });

  it('orders by deadline, clockless games last', async () => {
    const { group, bot, human } = await setup();
    const late = await insertGame(db, group.id, bot.id, human.id, { deadlineInSeconds: 7200 });
    const none = await insertGame(db, group.id, bot.id, human.id, { timePerMove: null });
    const soon = await insertGame(db, group.id, bot.id, human.id, { deadlineInSeconds: 600 });
    const turns = await pendingTurns(db, [bot.id]);
    expect(turns.map((t) => t.gameId)).toEqual([soon.id, late.id, none.id]);
  });

  it("sorts a challenge by its expiry among the games' deadlines", async () => {
    const { group, bot, human } = await setup();
    const game = await insertGame(db, group.id, bot.id, human.id, { deadlineInSeconds: 3600 });
    const before = await insertChallenge(db, group.id, human.id, bot.id, { expiresInSeconds: 600 });
    const after = await insertChallenge(db, group.id, human.id, bot.id, { expiresInSeconds: 7200 });
    const turns = await pendingTurns(db, [bot.id]);
    expect(turns.map((t) => t.gameId ?? `c${t.challengeId}`)).toEqual([
      `c${before.id}`,
      game.id,
      `c${after.id}`,
    ]);
    expect(turns[0]!.deadlineAt).toEqual(before.expiresAt);
  });

  it('covers several bots in one read and ignores others', async () => {
    const { group, bot, human } = await setup();
    const owner = await insertUser(db);
    const other = await insertBot(db, owner, { firstName: 'Knight' });
    const stranger = await insertBot(db, human, { firstName: 'Theirs' });
    await insertChallenge(db, group.id, human.id, bot.id);
    await insertChallenge(db, group.id, human.id, other.id);
    await insertChallenge(db, group.id, human.id, stranger.id);
    const turns = await pendingTurns(db, [bot.id, other.id]);
    expect(turns.map((t) => t.botId).sort()).toEqual([bot.id, other.id].sort());
  });
});

describe('sameTurn', () => {
  const key = { botId: 1, kind: 'move' as const, gameId: 2, challengeId: null, ply: 3 };
  it('compares all five fields', () => {
    expect(sameTurn(key, { ...key })).toBe(true);
    expect(sameTurn(key, { ...key, botId: 9 })).toBe(false);
    expect(sameTurn(key, { ...key, kind: 'draw_offer' })).toBe(false);
    expect(sameTurn(key, { ...key, gameId: 9 })).toBe(false);
    expect(sameTurn(key, { ...key, challengeId: 9 })).toBe(false);
    expect(sameTurn(key, { ...key, ply: 9 })).toBe(false);
  });
});
