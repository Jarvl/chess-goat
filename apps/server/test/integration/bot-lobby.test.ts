import { BotLobbyDtoSchema, type BotLobbyDto } from '@chess-goat/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { games, ratings } from '../../src/db/schema';
import { blockUser, touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

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

async function setup() {
  const group = await insertGroup(db);
  const owner = await insertUser(db, { telegramUserId: 11, firstName: 'Owner', username: 'owner' });
  await touchMember(db, group.id, owner.id, { verified: true });
  const token = await api.sessionFor(owner);
  return { group, owner, token };
}

async function addBot(groupId: number, owner: Parameters<typeof insertBot>[1]) {
  const bot = await insertBot(db, owner);
  await touchMember(db, groupId, bot.id);
  return bot;
}

const rate = (groupId: number, userId: number, rating: number, gamesPlayed = 3) =>
  db.insert(ratings).values({
    groupId,
    userId,
    rating,
    rd: 80,
    volatility: 0.06,
    gamesPlayed,
    wins: gamesPlayed,
    draws: 0,
    losses: 0,
  });

const lobby = async (token: string, publicId: string): Promise<BotLobbyDto> => {
  const res = await api.request('GET', `/api/groups/${publicId}/bot-lobby`, { token });
  expect(res.status).toBe(200);
  return BotLobbyDtoSchema.parse(await res.json());
};

describe('GET /api/groups/:g/bot-lobby', () => {
  it('lists only bot-vs-bot games: live newest move first, recent finished and not void', async () => {
    const { group, owner, token } = await setup();
    const a = await addBot(group.id, owner);
    const b = await addBot(group.id, owner);
    const human = await insertUser(db, { telegramUserId: 12 });
    await touchMember(db, group.id, human.id);
    const older = await insertGame(db, group.id, a.id, b.id, {
      botPlayers: 2,
      lastMoveAt: new Date('2026-01-01T10:00:00Z'),
    });
    const newer = await insertGame(db, group.id, b.id, a.id, {
      botPlayers: 2,
      lastMoveAt: new Date('2026-01-01T11:00:00Z'),
    });
    await insertGame(db, group.id, a.id, human.id, { botPlayers: 1 });
    const done = await insertGame(db, group.id, a.id, b.id, {
      botPlayers: 2,
      status: 'finished',
      result: '1-0',
      finishedAt: new Date('2026-01-02T10:00:00Z'),
    });
    await insertGame(db, group.id, a.id, b.id, {
      botPlayers: 2,
      status: 'finished',
      result: '1-0',
      finishedAt: new Date('2026-01-03T10:00:00Z'),
      voidedAt: new Date('2026-01-03T11:00:00Z'),
    });
    await insertGame(db, group.id, a.id, human.id, {
      botPlayers: 1,
      status: 'finished',
      result: '1-0',
      finishedAt: new Date('2026-01-04T10:00:00Z'),
    });
    const body = await lobby(token, group.publicId);
    expect(body.live.map((g) => g.id)).toEqual([newer.publicId, older.publicId]);
    expect(body.recent.map((g) => g.id)).toEqual([done.publicId]);
  });

  it('caps live games at 50 and recent games at 20', async () => {
    const { group, owner, token } = await setup();
    const a = await addBot(group.id, owner);
    const b = await addBot(group.id, owner);
    for (const status of ['active', 'finished'] as const) {
      const count = status === 'active' ? 55 : 25;
      await db.insert(games).values(
        Array.from({ length: count }, (_, i) => ({
          publicId: `${status === 'active' ? 'A' : 'F'}${String(i).padStart(9, '0')}`,
          groupId: group.id,
          whiteId: a.id,
          blackId: b.id,
          timePerMove: 86400,
          rated: true,
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          botPlayers: 2,
          status,
          ...(status === 'finished' ? { result: '1-0' as const, finishedAt: new Date() } : {}),
        })),
      );
    }
    const body = await lobby(token, group.publicId);
    expect(body.live).toHaveLength(50);
    expect(body.recent).toHaveLength(20);
  });

  it('ranks bots with games played, leaving out people and blocked bots or owners', async () => {
    const { group, owner, token } = await setup();
    const top = await addBot(group.id, owner);
    const mid = await addBot(group.id, owner);
    const unplayed = await addBot(group.id, owner);
    const blocked = await addBot(group.id, owner);
    const other = await insertUser(db, { telegramUserId: 13, firstName: 'Other' });
    await touchMember(db, group.id, other.id);
    const otherBot = await addBot(group.id, other);
    await rate(group.id, top.id, 1700);
    await rate(group.id, mid.id, 1600);
    await rate(group.id, unplayed.id, 1900, 0);
    await rate(group.id, blocked.id, 1800);
    await rate(group.id, otherBot.id, 1750);
    await rate(group.id, owner.id, 2000);
    await blockUser(db, group.id, blocked.id, owner.id);
    await blockUser(db, group.id, other.id, owner.id);
    const body = await lobby(token, group.publicId);
    expect(body.standings.map((e) => e.rating)).toEqual([1700, 1600]);
    expect(body.standings.every((e) => e.botActivity !== undefined)).toBe(true);
  });

  it('is members only', async () => {
    const { group } = await setup();
    const outsider = await insertUser(db, { telegramUserId: 99 });
    const token = await api.sessionFor(outsider);
    const res = await api.request('GET', `/api/groups/${group.publicId}/bot-lobby`, { token });
    expect(res.status).toBe(403);
  });
});
