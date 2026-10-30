import { encodePremoveBytes } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boardImages, games, jobs, shares, users } from '../../src/db/schema';
import { storePhoto } from '../../src/domain/photos';
import { loadFonts } from '../../src/images/fonts';
import { sharePhotoJobHandlers } from '../../src/jobs/handlers/sharePhoto';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000005;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

beforeAll(async () => {
  fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url });
  const api = createTelegramApi(config, { apiRoot: fake.url });
  const fonts = await loadFonts();
  worker = new JobWorker({
    db,
    log: deps.log,
    handlers: sharePhotoJobHandlers({ deps, api, config }, fonts),
    workerId: 's',
  });
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function table(botStatus: 'administrator' | 'left' = 'administrator') {
  const group = await insertGroup(db, { telegramChatId: CHAT, botStatus });
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  const game = await insertGame(db, group.id, alice.id, bob.id, {
    fen: AFTER_E4_C5,
    plyCount: 2,
    cardThreadId: 7,
  });
  await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
  await insertMove(db, game.id, 2, 'c7c5', 'c5', AFTER_E4_C5);
  return { group, alice, bob, carol, game };
}

async function share(gameId: number, userId: number, ply: number, createdAt?: Date) {
  const [row] = await db
    .insert(shares)
    .values({ gameId, userId, ply, ...(createdAt ? { createdAt } : {}) })
    .returning();
  await enqueue(db, { kind: 'send_share_photo', payload: { shareId: row!.id } });
  return row!;
}

const pendingJobs = () =>
  db
    .select()
    .from(jobs)
    .where(sql`${jobs.doneAt} is null`);

describe('send_share_photo', () => {
  it('names the sharer and both players with their worn flair', async () => {
    const { alice, bob, carol, game } = await table();
    await db
      .update(users)
      .set({ flairWorn: ['en_passant_win'] })
      .where(eq(users.id, alice.id));
    await db
      .update(users)
      .set({ flairWorn: ['draws_10'] })
      .where(eq(users.id, bob.id));
    await db
      .update(users)
      .set({ flairWorn: ['rank_1500'] })
      .where(eq(users.id, carol.id));
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')[0]?.body.caption).toBe(
      'Carol 🚶 shared move 1 of Alice 👑 vs Bob 🤝',
    );
  });

  it('uploads the rendered board with caption, topic and button, then stores the message and file ids', async () => {
    const { group, alice, game } = await table();
    const row = await share(game.id, alice.id, 2);
    await worker.runOnce();
    const [call] = fake.callsTo('sendPhoto');
    expect(call?.multipart).toBe(true);
    expect(call?.body.__file).toBe(true);
    expect(call?.body.chat_id).toBe(String(CHAT));
    expect(call?.body.message_thread_id).toBe('7');
    expect(call?.body.caption).toBe('Alice shared move 1 of Alice vs Bob');
    const markup = JSON.parse(String(call?.body.reply_markup)) as {
      inline_keyboard: { text: string; url: string }[][];
    };
    expect(markup.inline_keyboard[0]?.[0]).toEqual({
      text: '♟ Open live game',
      url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}`,
    });
    expect(markup.inline_keyboard[1]).toEqual([
      {
        text: '♟ Group lobby',
        url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
      },
    ]);
    const [stored] = await db.select().from(shares);
    expect(stored?.id).toBe(row.id);
    expect(stored?.messageId).toBe(101);
    expect(await db.select().from(boardImages)).toMatchObject([
      { telegramFileId: 'AgACAgIAAxkFake' },
    ]);
    expect(await pendingJobs()).toHaveLength(0);
  });

  it('reuses the cached file id for an identical card', async () => {
    const { alice, carol, game } = await table();
    await db
      .update(games)
      .set({ status: 'finished', result: '1-0', endReason: 'resignation', deadlineAt: null })
      .where(eq(games.id, game.id));
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    const calls = fake.callsTo('sendPhoto');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.multipart).toBe(false);
    expect(calls[1]?.body.photo).toBe('AgACAgIAAxkFake');
    expect(calls[1]?.body.caption).toBe('Carol shared move 1 of Alice vs Bob');
    expect(await db.select().from(boardImages)).toHaveLength(1);
    expect((await db.select().from(shares)).map((row) => row.messageId)).toEqual([101, 102]);
  });

  it('reuses the cached file id for an active game shared again later, as the card has no clock', async () => {
    const { carol, game } = await table();
    await share(game.id, carol.id, 2, new Date(Date.now() - 2 * 3_600_000));
    await worker.runOnce();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, false]);
    expect(await db.select().from(boardImages)).toHaveLength(1);
  });

  it("renders a new card once a player's Telegram photo is stored", async () => {
    const { alice, carol, game } = await table();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    await storePhoto(db, alice.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });

  it('renders a new card once a player wears different flair', async () => {
    const { alice, carol, game } = await table();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    await db
      .update(users)
      .set({ flairWorn: ['win_streak_5'] })
      .where(eq(users.id, alice.id));
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });

  it('renders from the black side when Black shares, which is a different image', async () => {
    const { alice, bob, game } = await table();
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    await share(game.id, bob.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });

  it('leaves a stored premove tree out of the card, for its owner and the opponent alike', async () => {
    const { alice, bob, game } = await table();
    await share(game.id, alice.id, 2);
    await share(game.id, bob.id, 2);
    await worker.runOnce();
    // White is to move, so the tree is Bob's (conditional premoves spec: the side not to move owns it).
    await db
      .update(games)
      .set({
        premoveTree: Buffer.from(
          encodePremoveBytes([{ move: 'e2e4', reply: 'd7d5', children: [] }]),
        ),
        premoveTreePly: 2,
      })
      .where(eq(games.id, game.id));
    await share(game.id, alice.id, 2);
    await share(game.id, bob.id, 2);
    await worker.runOnce();
    // Each card is cached by its rendered image: reusing the file id means the image is the same.
    const calls = fake.callsTo('sendPhoto');
    expect(calls.map((call) => call.multipart)).toEqual([true, true, false, false]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
    expect(calls.map((call) => call.body.caption)).toEqual([
      'Alice shared move 1 of Alice vs Bob',
      'Bob shared move 1 of Alice vs Bob',
      'Alice shared move 1 of Alice vs Bob',
      'Bob shared move 1 of Alice vs Bob',
    ]);
  });

  it('shares the initial position and an earlier ply', async () => {
    const { carol, game } = await table();
    await share(game.id, carol.id, 0);
    await share(game.id, carol.id, 1);
    await worker.runOnce();
    const captions = fake.callsTo('sendPhoto').map((call) => call.body.caption);
    expect(captions).toEqual([
      'Carol shared move 1 of Alice vs Bob',
      'Carol shared move 1 of Alice vs Bob',
    ]);
  });

  it('delays the photo on a 429 without counting an attempt', async () => {
    const { alice, game } = await table();
    await share(game.id, alice.id, 2);
    fake.failNext('sendPhoto', {
      error_code: 429,
      description: 'Too Many Requests: retry after 7',
      parameters: { retry_after: 7 },
    });
    await worker.runOnce();
    const [job] = await pendingJobs();
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toContain('retry after 7');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 5_000);
    expect(await db.select().from(boardImages)).toHaveLength(0);
  });

  it('does nothing once the share was sent or when the bot has left', async () => {
    const { alice, game } = await table('left');
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(0);
    expect(await pendingJobs()).toHaveLength(0);
  });
});
