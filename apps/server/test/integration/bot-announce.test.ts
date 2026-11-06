import { encodeStartParam } from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { botAnnouncements, jobs } from '../../src/db/schema';
import { announceBot } from '../../src/domain/botAnnounce';
import { updateGroupSettings } from '../../src/domain/groups';
import { telegramJobHandlers } from '../../src/jobs/handlers/telegram';
import type { JobWorker } from '../../src/jobs/worker';
import { blockUser, markLeft, touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import { insertBot, insertGroup, insertUser } from '../helpers/fixtures';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const deps = testDeps(db);
let api: TestApi;
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000077;

beforeAll(async () => {
  api = await startTestApi(db);
  ({ fake, worker } = await jobWorker(deps, telegramJobHandlers));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
  api.fake.reset();
  api.ctx.membership.clearCaches();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await fake.stop();
  await close();
});

async function setup(botOverrides: Parameters<typeof insertBot>[2] = {}) {
  const group = await insertGroup(db, {
    telegramChatId: CHAT,
    botStatus: 'administrator',
    botIsAdmin: true,
  });
  const owner = await insertUser(db, { telegramUserId: 11, firstName: 'Owner', username: 'owner' });
  const bot = await insertBot(db, owner, { firstName: 'Rook', ...botOverrides });
  await touchMember(db, group.id, owner.id, { verified: true });
  await touchMember(db, group.id, bot.id);
  return { group, owner, bot, token: await api.sessionFor(owner) };
}

const announce = (token: string, group: { publicId: string }, bot: { id: number }) =>
  api.request('POST', `/api/groups/${group.publicId}/bots/${bot.id}/announce`, { token });

describe('POST /api/groups/:g/bots/:id/announce', () => {
  it('queues one send_bot_announce job', async () => {
    const { group, bot, token } = await setup();
    const res = await announce(token, group, bot);
    expect(res.status).toBe(200);
    const rows = await db.select().from(jobs).where(eq(jobs.kind, 'send_bot_announce'));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(botAnnouncements)).toHaveLength(1);
  });

  it('sends the card text and buttons', async () => {
    const { group, bot, token } = await setup({ tagline: 'Loves endgames' });
    await announce(token, group, bot);
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body).toMatchObject({
      chat_id: CHAT,
      text: '🤖 Rook (@owner) is taking challenges.\n"Loves endgames"',
    });
    expect(call?.body.message_thread_id).toBeUndefined();
    const startapp = (kind: 'challengeBot' | 'lobby') =>
      `https://t.me/TestChessBot/chess?startapp=${encodeStartParam(
        kind === 'lobby'
          ? { kind, groupId: group.publicId }
          : { kind, groupId: group.publicId, botId: bot.id },
      )}`;
    expect(call?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Challenge 🤖 Rook (@owner)', url: startapp('challengeBot') }],
        [{ text: '♟ Group lobby', url: startapp('lobby') }],
      ],
    });
  });

  it('leaves out the tagline line when there is none, and uses the fixed topic', async () => {
    const { group, bot, token } = await setup();
    await updateGroupSettings(db, group.id, { cardTopicMode: 'fixed', fixedTopicId: 9 });
    await announce(token, group, bot);
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body.text).toBe('🤖 Rook (@owner) is taking challenges.');
    expect(call?.body.message_thread_id).toBe(9);
  });

  it('refuses a second post within 24 h, and allows one after', async () => {
    const { group, owner, bot, token } = await setup();
    expect((await announce(token, group, bot)).status).toBe(200);
    const again = await announce(token, group, bot);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: { code: 'rate_limited' } });
    await expect(
      announceBot(deps, { ownerId: owner.id, botId: bot.id, groupId: group.id }),
    ).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'announce_limit' } });
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'send_bot_announce'))).toHaveLength(1);
    await db.update(botAnnouncements).set({ postedAt: sql`now() - interval '25 hours'` });
    expect((await announce(token, group, bot)).status).toBe(200);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'send_bot_announce'))).toHaveLength(2);
  });

  it("refuses the owner's second bot in the same group within 24 h, but not in another group", async () => {
    const { group, owner, bot, token } = await setup();
    const pawn = await insertBot(db, owner, { firstName: 'Pawn' });
    await touchMember(db, group.id, pawn.id);
    expect((await announce(token, group, bot)).status).toBe(200);
    const second = await announce(token, group, pawn);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { code: 'rate_limited', reason: 'announce_limit' },
    });
    const other = await insertGroup(db, { botStatus: 'administrator' });
    await touchMember(db, other.id, owner.id, { verified: true });
    await touchMember(db, other.id, pawn.id);
    expect((await announce(token, other, pawn)).status).toBe(200);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'send_bot_announce'))).toHaveLength(2);
  });

  it('drops the card when the bot may no longer play there by the time it is sent', async () => {
    const { group, owner, bot, token } = await setup();
    expect((await announce(token, group, bot)).status).toBe(200);
    await blockUser(db, group.id, bot.id, owner.id);
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toHaveLength(0);

    const pawn = await insertBot(db, owner, { firstName: 'Pawn' });
    const other = await insertGroup(db, { botStatus: 'administrator' });
    await touchMember(db, other.id, owner.id, { verified: true });
    await touchMember(db, other.id, pawn.id);
    expect((await announce(token, other, pawn)).status).toBe(200);
    await markLeft(db, other.id, owner.id);
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
  });

  it('is 404 for someone who is not the owner', async () => {
    const { group, bot } = await setup();
    const other = await insertUser(db, { telegramUserId: 12, firstName: 'Other' });
    await touchMember(db, group.id, other.id, { verified: true });
    const res = await announce(await api.sessionFor(other), group, bot);
    expect(res.status).toBe(404);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'send_bot_announce'))).toHaveLength(0);
  });

  it('refuses a bot that is not in the group', async () => {
    const { group, owner, token } = await setup();
    const stray = await insertBot(db, owner, { firstName: 'Stray' });
    const res = await announce(token, group, stray);
    expect(res.status).toBe(403);
    await expect(
      announceBot(deps, { ownerId: owner.id, botId: stray.id, groupId: group.id }),
    ).rejects.toMatchObject({ details: { reason: 'bot_not_in_group' } });
  });
});
