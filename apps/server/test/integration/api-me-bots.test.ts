import { OwnerBotsDtoSchema } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, groupMembers } from '../../src/db/schema';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestApi(db);
});
afterAll(async () => {
  await api?.stop();
  await close();
});

const bots = async (token: string) => {
  const res = await api.request('GET', '/api/me/bots', { token });
  expect(res.status).toBe(200);
  return OwnerBotsDtoSchema.parse(await res.json()).bots;
};

describe('GET /api/me/bots', () => {
  it('is empty for someone with no bots', async () => {
    const session = await api.sessionFor(await insertUser(db));
    expect(await bots(session)).toEqual([]);
  });

  it("lists the owner's bots with groups, live games and recent games, and nobody else's", async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner, { tagline: 'plays the Bongcloud' });
    const rival = await insertBot(db, other);
    const stranger = await insertBot(db, other);
    for (const member of [bot, rival, stranger])
      await db.insert(groupMembers).values({ groupId: group.id, userId: member.id });
    await insertGame(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    for (let i = 0; i < 6; i += 1)
      await insertGame(db, group.id, i % 2 ? bot.id : rival.id, i % 2 ? rival.id : bot.id, {
        botPlayers: 2,
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: new Date(Date.UTC(2026, 8, 1 + i)),
      });
    await insertGame(db, group.id, stranger.id, rival.id, { botPlayers: 2 });

    const listed = await bots(await api.sessionFor(owner));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: bot.id,
      label: expect.stringContaining(`🤖 ${bot.firstName}`),
      tagline: 'plays the Bongcloud',
      liveGames: 1,
      groups: [{ groupId: group.publicId, rating: 1500, gamesPlayed: 0 }],
    });
    expect(listed[0]!.recent).toHaveLength(5);
    expect(listed[0]!.recent.every((g) => g.status === 'finished')).toBe(true);
    const times = listed[0]!.recent.map((g) => g.finishedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(await db.select().from(games).where(eq(games.groupId, group.id))).toHaveLength(8);
  });

  it('needs a session', async () => {
    const res = await api.request('GET', '/api/me/bots', {});
    expect(res.status).toBe(401);
  });
});
