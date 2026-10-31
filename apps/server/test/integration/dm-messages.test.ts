import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dmMessages, jobs, users } from '../../src/db/schema';
import { markWaiting, recordDm, retireGameDms } from '../../src/domain/dms';
import { telegramJobHandlers } from '../../src/jobs/handlers/telegram';
import type { JobWorker } from '../../src/jobs/worker';

import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;

beforeAll(async () => {
  ({ fake, worker } = await jobWorker(deps, telegramJobHandlers));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function setup() {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', dmAllowed: true });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob', username: 'bob' });
  const game = await insertGame(db, group.id, alice.id, bob.id);
  return { alice, bob, game };
}

const live = (userId: number, gameId: number, telegramMessageId: number) => ({
  userId,
  chatId: 11,
  gameId,
  telegramMessageId,
  kind: 'turn' as const,
  stub: 'Game vs @bob ended',
});
const rows = () => db.select().from(dmMessages);

describe('live DM rows', () => {
  it('replaces the live row and deletes the old message', async () => {
    const { alice, game } = await setup();
    await recordDm(db, live(alice.id, game.id, 101));
    await recordDm(db, live(alice.id, game.id, 102));
    expect((await rows()).map((row) => row.telegramMessageId)).toEqual([102]);
    await worker.runOnce();
    expect(fake.callsTo('deleteMessage').map((call) => call.body)).toEqual([
      { chat_id: 11, message_id: 101 },
    ]);
  });

  it('edits a message older than 47 hours to its stub', async () => {
    const { alice, game } = await setup();
    await recordDm(db, live(alice.id, game.id, 101));
    await db.update(dmMessages).set({ sentAt: sql`now() - interval '47 hours'` });
    await retireGameDms(db, game.id);
    expect(await rows()).toEqual([]);
    await worker.runOnce();
    expect(fake.callsTo('deleteMessage')).toEqual([]);
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({
      chat_id: 11,
      message_id: 101,
      text: 'Game vs @bob ended',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('applies the waiting edit with an Open game button', async () => {
    const { alice, game } = await setup();
    await recordDm(db, live(alice.id, game.id, 101));
    const text = '✓ You played 1. e4 · waiting for @bob';
    await markWaiting(db, { userId: alice.id, gameId: game.id, text });
    expect(await rows()).toMatchObject([{ kind: 'waiting', stub: text }]);
    await worker.runOnce();
    expect(fake.callsTo('editMessageText')[0]?.body).toEqual({
      chat_id: 11,
      message_id: 101,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '♟ Open game',
              web_app: { url: `https://chess.test/app/?startapp=g_${game.publicId}` },
            },
          ],
        ],
      },
    });
  });

  it('does nothing when there is no live row to mark waiting', async () => {
    const { alice, game } = await setup();
    await markWaiting(db, { userId: alice.id, gameId: game.id, text: 'x' });
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('lets a retire override a pending waiting edit for the same message', async () => {
    const { alice, game } = await setup();
    await recordDm(db, live(alice.id, game.id, 101));
    await markWaiting(db, { userId: alice.id, gameId: game.id, text: 'waiting' });
    await retireGameDms(db, game.id);
    await worker.runOnce();
    expect(fake.calls.map((call) => call.method)).toEqual(['deleteMessage']);
  });

  it('treats a missing message as done', async () => {
    const { alice, game } = await setup();
    await recordDm(db, live(alice.id, game.id, 101));
    await retireGameDms(db, game.id);
    fake.failNext('deleteMessage', {
      error_code: 400,
      description: 'Bad Request: message to delete not found',
    });
    await worker.runOnce();
    expect(fake.callsTo('deleteMessage')).toHaveLength(1);
    expect((await db.select().from(jobs)).map((job) => job.doneAt !== null)).toEqual([true]);
  });

  it('turns DMs off and forgets rows when the user blocked the bot', async () => {
    const { alice, bob, game } = await setup();
    const group2 = await insertGroup(db);
    const other = await insertGame(db, group2.id, alice.id, bob.id);
    await recordDm(db, live(alice.id, game.id, 101));
    await recordDm(db, live(alice.id, other.id, 102));
    await markWaiting(db, { userId: alice.id, gameId: game.id, text: 'waiting' });
    fake.failNext('editMessageText', {
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await worker.runOnce();
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]?.dmAllowed).toBe(false);
    expect(await rows()).toEqual([]);
  });
});
