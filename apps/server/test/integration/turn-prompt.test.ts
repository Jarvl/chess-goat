import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, turnLeases, users, type TurnLeaseRow, type UserRow } from '../../src/db/schema';
import { setMatchNotes } from '../../src/domain/botNotes';
import { loadTurnView, renderTurnPrompt } from '../../src/domain/turnPrompt';
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

async function insertLease(values: typeof turnLeases.$inferInsert): Promise<TurnLeaseRow> {
  const [row] = await db.insert(turnLeases).values(values).returning();
  return row!;
}

async function setup() {
  const group = await insertGroup(db, { title: 'Chess Club' });
  const owner = await insertUser(db);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { firstName: 'Alice' });
  const game = await insertGame(db, group.id, bot.id, human.id);
  return { group, owner, bot, human, game };
}

const reload = async (bot: UserRow): Promise<UserRow> =>
  (await db.select().from(users).where(eq(users.id, bot.id)))[0]!;

describe('loadTurnView', () => {
  it('loads a move turn with a failed premove and both notes', async () => {
    const { bot, human, game } = await setup();
    await db.update(users).set({ botNotes: 'Likes e4.' }).where(eq(users.id, bot.id));
    await setMatchNotes(db, { botId: bot.id, gameId: game.id, text: 'Alice is slow.' });
    await db
      .update(games)
      .set({ premoveFailure: { ply: 0, opponentMove: 'e7e5', reply: 'g1f4', botId: bot.id } })
      .where(eq(games.id, game.id));
    const lease = await insertLease({ botId: bot.id, kind: 'move', gameId: game.id, ply: 0 });
    const view = await loadTurnView(db, lease, await reload(bot));
    expect(view).toMatchObject({
      kind: 'move',
      bot: 'Rook',
      botNotes: 'Likes e4.',
      matchNotes: 'Alice is slow.',
      premoveFailed: { opponentMove: 'e7e5', reply: 'g1f4' },
    });
    if (view.kind !== 'move') throw new Error('unreachable');
    expect(view.game.opponent.name).toBe('Alice');
    expect(human.id).toBeGreaterThan(0);
    const text = renderTurnPrompt(view);
    expect(text).toContain('You are Rook. It is your move against Alice in Chess Club.');
    expect(text).toContain('Likes e4.');
    expect(text).toContain('Alice is slow.');
    expect(text).toContain('Your premove reply g1f4 to e7e5 was illegal');
    expect(text).toContain('Legal moves: a3, a4, b3');
  });

  it('leaves a premove failure of another ply or bot out', async () => {
    const { bot, human, game } = await setup();
    await db
      .update(games)
      .set({ premoveFailure: { ply: 0, opponentMove: 'e7e5', reply: 'g1f4', botId: human.id } })
      .where(eq(games.id, game.id));
    const lease = await insertLease({ botId: bot.id, kind: 'move', gameId: game.id, ply: 0 });
    const view = await loadTurnView(db, lease, bot);
    expect(view).not.toHaveProperty('premoveFailed');
  });

  it('loads a draw offer turn', async () => {
    const { bot, game } = await setup();
    // The bot (White) moved; Alice offers a draw on her turn.
    const moved = await played(db, game, ['e2e4']);
    await db.update(games).set({ drawOfferBy: 'black' }).where(eq(games.id, moved.id));
    const lease = await insertLease({ botId: bot.id, kind: 'draw_offer', gameId: game.id, ply: 1 });
    const view = await loadTurnView(db, lease, bot);
    expect(view.kind).toBe('draw_offer');
    expect(renderTurnPrompt(view)).toContain('Alice offers a draw in your game in Chess Club.');
  });

  it('loads a challenge turn', async () => {
    const { bot, group, human } = await setup();
    const challenge = await insertChallenge(db, group.id, human.id, bot.id, {
      challengerColour: 'white',
      timePerMove: null,
      rated: false,
    });
    const lease = await insertLease({
      botId: bot.id,
      kind: 'challenge',
      challengeId: challenge.id,
    });
    const view = await loadTurnView(db, lease, bot);
    expect(view).toMatchObject({
      kind: 'challenge',
      bot: 'Rook',
      challenge: {
        from: 'Alice',
        group: 'Chess Club',
        timePerMove: null,
        rated: false,
        colour: 'black',
        expiresAt: challenge.expiresAt.toISOString(),
      },
    });
  });

  it('loads a game-over turn with the match notes', async () => {
    const { bot, game } = await setup();
    await setMatchNotes(db, { botId: bot.id, gameId: game.id, text: 'Good game.' });
    await db
      .update(games)
      .set({ status: 'finished', result: '1-0', endReason: 'resignation' })
      .where(eq(games.id, game.id));
    const lease = await insertLease({ botId: bot.id, kind: 'game_over', gameId: game.id });
    const view = await loadTurnView(db, lease, bot);
    expect(view).toMatchObject({ kind: 'game_over', matchNotes: 'Good game.' });
    expect(renderTurnPrompt(view)).toContain('is over: you won by resignation.');
  });

  it('needs only the name for a practice turn', async () => {
    const { bot } = await setup();
    const lease = await insertLease({ botId: bot.id, kind: 'practice' });
    expect(await loadTurnView(db, lease, bot)).toEqual({ kind: 'practice', bot: 'Rook' });
  });

  it('ends the turn when the game or challenge is gone', async () => {
    const { bot, game } = await setup();
    const lease = await insertLease({ botId: bot.id, kind: 'move', gameId: game.id, ply: 0 });
    const gone = { ...lease, gameId: game.id + 999 };
    await expect(loadTurnView(db, gone, bot)).rejects.toMatchObject({
      code: 'stale_state',
      details: { reason: 'turn_ended' },
    });
    const challengeLease = {
      ...lease,
      kind: 'challenge' as const,
      gameId: null,
      challengeId: 999999,
    };
    await expect(loadTurnView(db, challengeLease, bot)).rejects.toMatchObject({
      details: { reason: 'turn_ended' },
    });
  });
});
