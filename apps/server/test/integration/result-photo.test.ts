import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boardImages, games, jobs, shares, users } from '../../src/db/schema';
import { flairAwardDedupKey } from '../../src/domain/games';
import { loadFonts } from '../../src/images/fonts';
import { sharePhotoJobHandlers } from '../../src/jobs/handlers/sharePhoto';
import { enqueue } from '../../src/jobs/queue';
import type { JobWorker } from '../../src/jobs/worker';

import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import {
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
  type GameOverrides,
} from '../helpers/fixtures';
import { AFTER_E4, AFTER_E4_C5 } from '../helpers/chess';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000006;

beforeAll(async () => {
  const fonts = await loadFonts();
  ({ fake, worker } = await jobWorker(deps, (ctx) => sharePhotoJobHandlers(ctx, fonts)));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const FINISHED: GameOverrides = {
  status: 'finished',
  result: '1-0',
  endReason: 'resignation',
  finishedAt: new Date(),
  deadlineAt: null,
  fen: AFTER_E4_C5,
  plyCount: 2,
  cardThreadId: 7,
};

async function finished(
  overrides: GameOverrides = {},
  botStatus: 'administrator' | 'left' = 'administrator',
) {
  const group = await insertGroup(db, { telegramChatId: CHAT, botStatus });
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const game = await insertGame(db, group.id, alice.id, bob.id, { ...FINISHED, ...overrides });
  await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
  await insertMove(db, game.id, 2, 'c7c5', 'c5', AFTER_E4_C5);
  return { group, alice, bob, game };
}

const post = (gameId: number) => enqueue(db, { kind: 'send_result_photo', payload: { gameId } });

const buttons = (call: { body: Record<string, unknown> } | undefined) =>
  (
    JSON.parse(String(call?.body.reply_markup)) as {
      inline_keyboard: { text: string; url: string }[][];
    }
  ).inline_keyboard;

const pendingJobs = () =>
  db
    .select()
    .from(jobs)
    .where(sql`${jobs.doneAt} is null`);

describe('send_result_photo', () => {
  it('names both players with their worn flair in the caption', async () => {
    const { alice, bob, game } = await finished();
    await db
      .update(users)
      .set({ flairWorn: ['en_passant_win'] })
      .where(eq(users.id, alice.id));
    await db
      .update(users)
      .set({ flairWorn: ['draws_10'] })
      .where(eq(users.id, bob.id));
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')[0]?.body.caption).toBe(
      'Alice 👑 vs Bob 🤝 · 1-0 · Resignation',
    );
  });

  it('posts the final position to the game’s topic with the result, rating changes and buttons', async () => {
    const { game } = await finished({
      whiteRatingBefore: 1500,
      whiteRatingAfter: 1534.4,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRatingAfter: 1465.6,
      blackRdBefore: 350,
      blackRdAfter: 290,
    });
    await post(game.id);
    await worker.runOnce();
    const [call] = fake.callsTo('sendPhoto');
    expect(call?.multipart).toBe(true);
    expect(call?.body.chat_id).toBe(String(CHAT));
    expect(call?.body.message_thread_id).toBe('7');
    expect(call?.body.caption).toBe(
      'Alice vs Bob · 1-0 · Resignation\nAlice 1500? → 1534? · Bob 1500? → 1466?',
    );
    expect(buttons(call)).toEqual([
      [
        {
          text: '♟ Open game',
          url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}`,
        },
      ],
      [{ text: '🔍 Analyze on Lichess', url: 'https://lichess.org/analysis/pgn/e4_c5' }],
    ]);
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row?.resultMessageId).toBe(101);
    expect(await db.select().from(boardImages)).toHaveLength(1);
    expect(await pendingJobs()).toHaveLength(0);
  });

  it('draws the rating change each game made, so the same position rated differently is another image', async () => {
    const ratings = {
      whiteRatingBefore: 1500,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRdBefore: 350,
      blackRdAfter: 290,
    };
    const { group, alice, bob, game } = await finished({
      ...ratings,
      whiteRatingAfter: 1534,
      blackRatingAfter: 1466,
    });
    const rematch = await insertGame(db, group.id, alice.id, bob.id, {
      ...FINISHED,
      ...ratings,
      whiteRatingAfter: 1520,
      blackRatingAfter: 1480,
    });
    await insertMove(db, rematch.id, 1, 'e2e4', 'e4', AFTER_E4);
    await insertMove(db, rematch.id, 2, 'c7c5', 'c5', AFTER_E4_C5);
    await post(game.id);
    await post(rematch.id);
    await worker.runOnce();
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });

  it('prefers the imported Lichess game for Analyze', async () => {
    const { game } = await finished({ lichessUrl: 'https://lichess.org/abcdefgh' });
    await post(game.id);
    await worker.runOnce();
    expect(buttons(fake.callsTo('sendPhoto')[0])[1]).toEqual([
      { text: '🔍 Analyze on Lichess', url: 'https://lichess.org/abcdefgh' },
    ]);
  });

  it('draws the board from the winner’s side: the same image Black’s own share of it would be', async () => {
    const { bob, game } = await finished({ result: '0-1', endReason: 'timeout' });
    const [share] = await db
      .insert(shares)
      .values({ gameId: game.id, userId: bob.id, ply: 2 })
      .returning();
    await enqueue(db, { kind: 'send_share_photo', payload: { shareId: share!.id } });
    await worker.runOnce();
    await post(game.id);
    await worker.runOnce();
    const calls = fake.callsTo('sendPhoto');
    expect(calls.map((call) => call.multipart)).toEqual([true, false]);
    expect(calls[1]?.body.caption).toBe('Alice vs Bob · 0-1 · Timeout');
  });

  it('words a casual draw without a rating line', async () => {
    const { game } = await finished({
      rated: false,
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')[0]?.body.caption).toBe('Alice vs Bob · ½-½ · Draw agreed');
  });

  it('words a game an admin voided while it was running', async () => {
    const { game } = await finished({ result: '*', endReason: 'voided', voidedAt: new Date() });
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')[0]?.body.caption).toBe('Alice vs Bob · Voided by an admin');
  });

  it('posts outside any topic when the card has none', async () => {
    const { game } = await finished({ cardThreadId: null });
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')[0]?.body.message_thread_id).toBeUndefined();
  });

  it('waits for the game’s flair award, so the photo shows flair the game earned', async () => {
    const { alice, game } = await finished();
    // The award is queued but not yet due, so the worker picks the result photo first.
    await enqueue(db, {
      kind: 'award_flair',
      payload: { gameId: game.id },
      dedupKey: flairAwardDedupKey(game.publicId),
      delaySeconds: 60,
    });
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(0);
    const [waiting] = (await pendingJobs()).filter((job) => job.kind === 'send_result_photo');
    expect(waiting?.attempts).toBe(0);
    expect(waiting!.runAt.getTime()).toBeGreaterThan(Date.now());

    // The award runs: Alice now wears what she earned, and the photo goes out with it.
    await db
      .update(users)
      .set({ flairWorn: ['win_streak_5'] })
      .where(eq(users.id, alice.id));
    await db.update(jobs).set({ doneAt: new Date() }).where(eq(jobs.kind, 'award_flair'));
    // The database clock, which the worker compares `run_at` against: the host clock can run
    // ahead of it by enough that the photo would not be due yet.
    await db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.kind, 'send_result_photo'));
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(1);
  });

  it('does not wait for a flair award that failed', async () => {
    const { game } = await finished();
    await enqueue(db, {
      kind: 'award_flair',
      payload: { gameId: game.id },
      dedupKey: flairAwardDedupKey(game.publicId),
      delaySeconds: 60,
    });
    await db
      .update(jobs)
      .set({ doneAt: new Date(), failedAt: new Date(), lastError: 'rule threw' })
      .where(eq(jobs.kind, 'award_flair'));
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(1);
  });

  it('posts once, even when the job runs again', async () => {
    const { game } = await finished();
    await post(game.id);
    await worker.runOnce();
    await post(game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(1);
    expect(await pendingJobs()).toHaveLength(0);
  });

  it('delays the photo on a 429 without counting an attempt', async () => {
    const { game } = await finished();
    await post(game.id);
    fake.failNext('sendPhoto', {
      error_code: 429,
      description: 'Too Many Requests: retry after 7',
      parameters: { retry_after: 7 },
    });
    await worker.runOnce();
    const [job] = await pendingJobs();
    expect(job?.attempts).toBe(0);
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row?.resultMessageId).toBeNull();
  });

  it('does nothing when the bot has left the group or the game is still running', async () => {
    const left = await finished({}, 'left');
    await post(left.game.id);
    await worker.runOnce();
    await truncateAll(db);
    const running = await finished({ status: 'active', result: null, endReason: null });
    await post(running.game.id);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto')).toHaveLength(0);
    expect(await pendingJobs()).toHaveLength(0);
  });
});
