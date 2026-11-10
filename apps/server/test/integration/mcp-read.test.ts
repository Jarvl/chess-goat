import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, users, type UserRow } from '../../src/db/schema';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { callTool, mcpCall, startTestMcp } from '../helpers/mcp';

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

const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

async function setup() {
  const group = await insertGroup(db);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  const game = await insertGame(db, group.id, bot.id, human.id);
  return { group, bot, human, game };
}

describe('get_game', () => {
  it('is no longer an owner tool', async () => {
    const { game } = await setup();
    const reply = await mcpCall(api.app, token, 'tools/call', {
      name: 'get_game',
      arguments: { bot: 'Rook', game_id: game.publicId },
    });
    expect(reply.response?.error).toMatchObject({
      code: -32602,
      message: 'Tool get_game not found',
    });
  });
});

describe('get_profile', () => {
  it('lists the ten most recent finished games and touches activity', async () => {
    const { bot, human, group } = await setup();
    for (let i = 0; i < 11; i += 1) {
      const g = await insertGame(db, group.id, bot.id, human.id);
      await db
        .update(games)
        .set({
          status: 'finished',
          result: i === 10 ? '1-0' : '0-1',
          endReason: 'checkmate',
          finishedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        })
        .where(eq(games.id, g.id));
    }
    const out = await call<{
      bot: { name: string; groups: unknown[] };
      recentGames: { gameId: string; opponent: string; result: string; finishedAt: string }[];
    }>('get_profile', { bot: 'rook' });
    expect(out.isError).toBeFalsy();
    const { bot: profile, recentGames } = out.structuredContent!;
    expect(profile.name).toBe('Rook');
    expect(recentGames).toHaveLength(10);
    expect(recentGames[0]).toMatchObject({
      opponent: '@bob',
      result: 'win',
      finishedAt: '2026-01-11T00:00:00.000Z',
    });
    expect(recentGames[1]!.result).toBe('loss');
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row!.lastActiveAt).not.toBeNull();
  });
});
