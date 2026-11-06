import { BotListDtoSchema, type BotListDto } from '@chess-goat/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ratings } from '../../src/db/schema';
import { blockUser, markLeft, touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGroup, insertUser } from '../helpers/fixtures';

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

async function addBot(
  groupId: number,
  owner: Parameters<typeof insertBot>[1],
  overrides: Parameters<typeof insertBot>[2] = {},
) {
  const bot = await insertBot(db, owner, overrides);
  await touchMember(db, groupId, bot.id);
  return bot;
}

const list = async (token: string, publicId: string, query = ''): Promise<BotListDto> => {
  const res = await api.request('GET', `/api/groups/${publicId}/bots${query}`, { token });
  expect(res.status).toBe(200);
  return BotListDtoSchema.parse(await res.json());
};

describe('GET /api/groups/:g/bots', () => {
  it('pages 25 bots as 20 plus 5', async () => {
    const { group, owner, token } = await setup();
    for (let i = 0; i < 25; i += 1) await addBot(group.id, owner);
    const first = await list(token, group.publicId);
    expect(first.bots).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(
      token,
      group.publicId,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.bots).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.bots, ...second.bots].map((b) => b.id);
    expect(new Set(ids).size).toBe(25);
  });

  it('sends the card: owner, tagline, rating, record and activity', async () => {
    const { group, owner, token } = await setup();
    const bot = await addBot(group.id, owner, {
      firstName: 'Rook',
      tagline: 'Loves endgames',
      lastActiveAt: new Date('2026-08-12T12:00:00.000Z'),
    });
    await db.insert(ratings).values({
      groupId: group.id,
      userId: bot.id,
      rating: 1620,
      rd: 80,
      volatility: 0.06,
      gamesPlayed: 6,
      wins: 3,
      draws: 1,
      losses: 2,
    });
    const [card] = (await list(token, group.publicId)).bots;
    expect(card).toMatchObject({
      id: String(bot.id),
      isBot: false,
      name: '🤖 Rook (@owner)',
      tagline: 'Loves endgames',
      owner: '@owner',
      rating: 1620,
      provisional: false,
      gamesPlayed: 6,
      record: { wins: 3, draws: 1, losses: 2 },
      botActivity: { lastActiveAt: '2026-08-12T12:00:00.000Z' },
    });
  });

  it('defaults an unrated bot to a provisional 1500 with an empty record', async () => {
    const { group, owner, token } = await setup();
    await addBot(group.id, owner);
    const [card] = (await list(token, group.publicId)).bots;
    expect(card).toMatchObject({
      rating: 1500,
      provisional: true,
      gamesPlayed: 0,
      record: { wins: 0, draws: 0, losses: 0 },
      botActivity: { lastActiveAt: null },
    });
  });

  it('searches case-insensitively and treats % literally', async () => {
    const { group, owner, token } = await setup();
    await addBot(group.id, owner, { firstName: 'Knightly' });
    await addBot(group.id, owner, { firstName: '100% Pawn' });
    await addBot(group.id, owner, { firstName: 'Bishop' });
    expect((await list(token, group.publicId, '?q=KNIGHT')).bots.map((b) => b.name)).toEqual([
      expect.stringContaining('Knightly'),
    ]);
    expect((await list(token, group.publicId, '?q=%25')).bots.map((b) => b.name)).toEqual([
      expect.stringContaining('100% Pawn'),
    ]);
  });

  it('sorts by activity and by newest', async () => {
    const { group, owner, token } = await setup();
    const old = await addBot(group.id, owner, { lastActiveAt: new Date('2026-01-01T00:00:00Z') });
    const recent = await addBot(group.id, owner, {
      lastActiveAt: new Date('2026-06-01T00:00:00Z'),
    });
    const never = await addBot(group.id, owner);
    const ids = async (sort: string) =>
      (await list(token, group.publicId, `?sort=${sort}`)).bots.map((b) => b.id);
    expect(await ids('active')).toEqual([String(recent.id), String(old.id), String(never.id)]);
    expect(await ids('newest')).toEqual([String(never.id), String(recent.id), String(old.id)]);
  });

  it('hides blocked bots, bots of blocked owners and bots whose owner left', async () => {
    const { group, owner, token } = await setup();
    const shown = await addBot(group.id, owner);
    const blocked = await addBot(group.id, owner);
    await blockUser(db, group.id, blocked.id, owner.id);
    const other = await insertUser(db, { firstName: 'Other' });
    await touchMember(db, group.id, other.id);
    await addBot(group.id, other);
    await markLeft(db, group.id, other.id);
    const bad = await insertUser(db, { firstName: 'Bad' });
    await touchMember(db, group.id, bad.id);
    await addBot(group.id, bad);
    await blockUser(db, group.id, bad.id, owner.id);
    expect((await list(token, group.publicId)).bots.map((b) => b.id)).toEqual([String(shown.id)]);
  });

  it('refuses a non-member and a bad cursor', async () => {
    const { group, token } = await setup();
    const stranger = await insertUser(db, { telegramUserId: 44 });
    const refused = await api.request('GET', `/api/groups/${group.publicId}/bots`, {
      token: await api.sessionFor(stranger),
    });
    expect(refused.status).toBe(403);
    const bad = await api.request('GET', `/api/groups/${group.publicId}/bots?cursor=nope`, {
      token,
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('refuses a cursor made for another sort', async () => {
    const { group, owner, token } = await setup();
    for (let i = 0; i < 21; i += 1) await addBot(group.id, owner);
    const first = await list(token, group.publicId);
    const res = await api.request(
      'GET',
      `/api/groups/${group.publicId}/bots?sort=newest&cursor=${encodeURIComponent(first.nextCursor!)}`,
      { token },
    );
    expect(res.status).toBe(400);
  });
});
