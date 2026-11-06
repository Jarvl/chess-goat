import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { countBotPlayers } from '../../src/domain/bots';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const violatesCheck = async (p: Promise<unknown>, name: string) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  expect(String((error as { cause?: unknown }).cause ?? error)).toContain(name);
};

describe('bot_players', () => {
  it('defaults to 0 on games and challenges and accepts 0 to 2', async () => {
    const group = await insertGroup(db);
    const a = await insertUser(db);
    const b = await insertUser(db);
    expect((await insertGame(db, group.id, a.id, b.id)).botPlayers).toBe(0);
    expect((await insertChallenge(db, group.id, a.id, b.id)).botPlayers).toBe(0);
    expect((await insertGame(db, group.id, a.id, b.id, { botPlayers: 2 })).botPlayers).toBe(2);
    expect((await insertChallenge(db, group.id, a.id, b.id, { botPlayers: 1 })).botPlayers).toBe(1);
  });

  it('rejects 3 and -1', async () => {
    const group = await insertGroup(db);
    const a = await insertUser(db);
    const b = await insertUser(db);
    await violatesCheck(
      insertGame(db, group.id, a.id, b.id, { botPlayers: 3 }),
      'games_bot_players_range',
    );
    await violatesCheck(
      insertChallenge(db, group.id, a.id, b.id, { botPlayers: -1 }),
      'challenges_bot_players_range',
    );
  });

  it('leaves users.last_active_at null', async () => {
    const owner = await insertUser(db);
    const bot = await insertBot(db, owner);
    expect(bot.lastActiveAt).toBeNull();
    expect(owner.lastActiveAt).toBeNull();
  });
});

describe('countBotPlayers', () => {
  it('counts the bots among the players', () => {
    const human = { ownerId: null };
    const bot = { ownerId: 5 };
    expect(countBotPlayers(human, human)).toBe(0);
    expect(countBotPlayers(human, bot)).toBe(1);
    expect(countBotPlayers(bot, human)).toBe(1);
    expect(countBotPlayers(bot, bot)).toBe(2);
    expect(countBotPlayers(bot, null)).toBe(1);
    expect(countBotPlayers(human, null)).toBe(0);
  });
});
