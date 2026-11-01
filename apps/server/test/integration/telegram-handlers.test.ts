import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, dmMessages, games, groups, jobs, moves, users } from '../../src/db/schema';
import { recordDm } from '../../src/domain/dms';
import { enqueue } from '../../src/jobs/queue';
import { telegramJobHandlers } from '../../src/jobs/handlers/telegram';
import type { JobWorker } from '../../src/jobs/worker';

import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import {
  insertChallenge,
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
} from '../helpers/fixtures';
import { AFTER_E4 } from '../helpers/chess';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000002;
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

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

async function people() {
  const group = await insertGroup(db, {
    telegramChatId: CHAT,
    botStatus: 'administrator',
    botIsAdmin: true,
    botCanPin: true,
  });
  const alice = await insertUser(db, {
    telegramUserId: 11,
    firstName: 'Alice',
    username: 'alice',
    dmAllowed: true,
  });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  return { group, alice, bob };
}
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);

describe('send_challenge_card', () => {
  it('posts the card to the topic and stores the message id', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { threadId: 5 });
    await enqueue(db, {
      kind: 'send_challenge_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:send:${challenge.publicId}`,
    });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body).toMatchObject({
      chat_id: CHAT,
      message_thread_id: 5,
      text: '♟ @alice challenges Bob\n1 day per move · Rated',
    });
    // 'Bob' has no handle, so the card mentions him by entity, after '♟ @alice challenges '.
    expect((call?.body.entities as unknown[])[0]).toMatchObject({
      type: 'text_mention',
      offset: 20,
      length: 3,
    });
    expect((await db.select().from(challenges))[0]?.messageId).toBe(101);
    expect(
      (call?.body.reply_markup as { inline_keyboard: { text: string; url?: string }[][] })
        .inline_keyboard[1],
    ).toEqual([
      {
        text: '♟ Group lobby',
        url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
      },
    ]);
  });

  it('puts worn flair after each name, outside the mention', async () => {
    const { group, alice, bob } = await people();
    await db
      .update(users)
      .set({ flairWorn: ['en_passant_win'] })
      .where(eq(users.id, alice.id));
    await db
      .update(users)
      .set({ flairWorn: ['win_streak_5', 'draws_10'] })
      .where(eq(users.id, bob.id));
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id);
    await enqueue(db, { kind: 'send_challenge_card', payload: { challengeId: challenge.id } });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body.text).toBe('♟ @alice 👑 challenges Bob 🔥🤝\n1 day per move · Rated');
    // ' 👑' is three UTF-16 units, so the mention of 'Bob' moves from offset 20 to 23.
    expect((call?.body.entities as unknown[])[0]).toMatchObject({
      type: 'text_mention',
      offset: 23,
      length: 3,
    });
  });

  it('hands the message id to a game accepted before the card was sent', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, {
      status: 'accepted',
      gameId: game.id,
    });
    await enqueue(db, { kind: 'send_challenge_card', payload: { challengeId: challenge.id } });
    await worker.runOnce();
    expect((await db.select().from(games))[0]?.cardMessageId).toBe(101);
    expect(
      (await jobRows()).filter((job) => job.doneAt === null).map((job) => job.dedupKey),
    ).toEqual([`card:g:${game.publicId}`]);
  });
});

describe('edit_card', () => {
  it('edits the running card in place', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      cardMessageId: 900,
      cardThreadId: 5,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await enqueue(db, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await worker.runOnce();
    const [call] = fake.callsTo('editMessageText');
    expect(call?.body).toMatchObject({
      chat_id: CHAT,
      message_id: 900,
      text: '♟ @alice (1500?) vs Bob (1500?)\n1 day per move · Rated · Move 1 · Bob to move',
    });
    expect(
      (call?.body.reply_markup as { inline_keyboard: { text: string; url?: string }[][] })
        .inline_keyboard[1],
    ).toEqual([
      {
        text: '♟ Group lobby',
        url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
      },
    ]);
  });

  it('retries an edit for a card that has no message id yet', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await enqueue(db, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await worker.runOnce();
    const [job] = await jobRows();
    expect(job).toMatchObject({ attempts: 1, doneAt: null });
    expect(job?.lastError).toMatch(/no message id/);
    expect(fake.callsTo('editMessageText')).toHaveLength(0);
  });

  it('treats "not modified" as done, marks a vanished card missing and waits out a 429', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { cardMessageId: 900 });
    const run = async () => {
      await enqueue(db, {
        kind: 'edit_card',
        payload: { gameId: game.id },
        dedupKey: `card:g:${game.publicId}`,
      });
      await worker.runOnce();
      return (await jobRows()).at(-1)!;
    };
    fake.failNext('editMessageText', {
      error_code: 400,
      description: 'Bad Request: message is not modified: same',
    });
    expect((await run()).doneAt).not.toBeNull();
    fake.failNext('editMessageText', {
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: { retry_after: 3 },
    });
    const waiting = await run();
    expect(waiting.doneAt).toBeNull();
    expect(waiting.lastError).toMatch(/429/);
    await db.delete(jobs);
    fake.failNext('editMessageText', {
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    expect((await run()).doneAt).not.toBeNull();
    expect((await db.select().from(games))[0]?.cardMissing).toBe(true);
  });

  it('marks a declined challenge on its card', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, {
      messageId: 700,
      status: 'declined',
    });
    await enqueue(db, {
      kind: 'edit_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:ch:${challenge.publicId}`,
    });
    await worker.runOnce();
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({
      message_id: 700,
      text: '♟ @alice vs Bob · Declined',
    });
  });
});

describe('send_dm', () => {
  it('sends nothing to a user who turned notifications off, whatever the template', async () => {
    const { group, alice, bob } = await people();
    await db
      .update(users)
      .set({ prefs: { notifications: false } })
      .where(eq(users.id, alice.id));
    const game = await insertGame(db, group.id, bob.id, alice.id, { fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    for (const template of ['turn', 'reminder'] as const)
      await enqueue(db, {
        kind: 'send_dm',
        payload: { userId: alice.id, template, gameId: game.id },
      });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
    expect((await db.select().from(jobs)).every((job) => job.doneAt !== null)).toBe(true);
  });

  it('sends the turn DM with both buttons', async () => {
    const { group, alice, bob } = await people();
    await db
      .update(users)
      .set({ flairWorn: ['rank_under_1200'] })
      .where(eq(users.id, bob.id));
    // Bob is White and has moved; it is Alice's (Black's) turn.
    const game = await insertGame(db, group.id, bob.id, alice.id, {
      cardMessageId: 900,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'turn', gameId: game.id },
    });
    await worker.runOnce();
    const sent = fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Your move vs Bob 🦍 · 1. e4 · 23 h left',
    });
    expect(sent[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: '♟ Open game',
            web_app: { url: `https://chess.test/app/?startapp=g_${game.publicId}` },
          },
        ],
        [{ text: 'Go to group', url: 'https://t.me/c/1000000002/900' }],
      ],
    });
  });

  it('skips a player on move who declined DMs', async () => {
    const { group, alice, bob } = await people();
    // Bob (White) is on move and has not allowed DMs.
    const game = await insertGame(db, group.id, bob.id, alice.id, { cardMessageId: 900 });
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: bob.id, template: 'turn', gameId: game.id },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toEqual([]);
    expect((await jobRows()).map((job) => job.doneAt !== null)).toEqual([true]);
  });

  it('sends the challenge DM and turns DMs off when the user blocked the bot', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Bob challenges you · 1 day per move · Rated',
    });
    fake.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id },
    });
    await worker.runOnce();
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]?.dmAllowed).toBe(false);
    expect((await jobRows()).every((job) => job.doneAt !== null)).toBe(true);
  });

  it('adds the cancelled line to the turn DM when the premoves were cancelled', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, bob.id, alice.id, {
      cardMessageId: 900,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'turn', gameId: game.id, premovesCancelledAtPly: 1 },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Your move vs Bob · 1. e4 · 23 h left\n\nYour premoves were cancelled.',
    });
  });
});

describe('send_dm live rows', () => {
  async function aliceToMove(overrides: Parameters<typeof insertGame>[4] = {}) {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, bob.id, alice.id, {
      cardMessageId: 900,
      fen: AFTER_E4,
      plyCount: 1,
      ...overrides,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    return { group, alice, bob, game };
  }
  const dm = (userId: number, gameId: number, template: string) =>
    enqueue(db, { kind: 'send_dm', payload: { userId, template, gameId } });
  const dmRows = () => db.select().from(dmMessages);
  const drain = async () => {
    for (let i = 0; i < 4; i += 1) await worker.runOnce();
  };

  it('records the turn DM as the live row', async () => {
    const { alice, game } = await aliceToMove();
    await dm(alice.id, game.id, 'turn');
    await drain();
    expect(await dmRows()).toMatchObject([
      {
        userId: alice.id,
        chatId: 11,
        gameId: game.id,
        telegramMessageId: 101,
        kind: 'turn',
        stub: 'Game vs Bob ended',
      },
    ]);
  });

  it('records the challenge DM as the live row', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id },
    });
    await drain();
    expect(await dmRows()).toMatchObject([
      { challengeId: challenge.id, kind: 'challenge', stub: 'Challenge from Bob expired' },
    ]);
  });

  it('adds the draw offer line when the opponent offered with their move', async () => {
    const { alice, game } = await aliceToMove({ drawOfferBy: 'white', drawOfferPly: 0 });
    await dm(alice.id, game.id, 'turn');
    await drain();
    expect(fake.callsTo('sendMessage')[0]?.body.text).toBe(
      'Your move vs Bob · 1. e4 · 23 h left\n\nBob offers a draw.',
    );
  });

  it('sends the draw offer DM', async () => {
    const { alice, game } = await aliceToMove({ drawOfferBy: 'white', drawOfferPly: 1 });
    await dm(alice.id, game.id, 'draw_offer');
    await drain();
    expect(fake.callsTo('sendMessage')[0]?.body.text).toBe('Bob offers a draw · 1. e4 · 23 h left');
    expect(await dmRows()).toMatchObject([{ kind: 'draw_offer' }]);
  });

  it('falls back to the turn DM when the offer is no longer standing', async () => {
    const { alice, game } = await aliceToMove();
    await dm(alice.id, game.id, 'draw_offer');
    await drain();
    expect(fake.callsTo('sendMessage')[0]?.body.text).toBe('Your move vs Bob · 1. e4 · 23 h left');
  });

  it('sends the result DM with the rating change and records no row', async () => {
    const { alice, game } = await aliceToMove({
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      blackRatingBefore: 1500,
      blackRatingAfter: 1491,
      blackRdBefore: 70,
      blackRdAfter: 60,
    });
    await dm(alice.id, game.id, 'result');
    await drain();
    const sent = fake.callsTo('sendMessage');
    expect(sent[0]?.body.text).toBe('You lost vs Bob · Resignation · 1491 (−9)');
    expect(sent[0]?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: '♟ Open game' }], [{ text: 'Go to group' }]],
    });
    expect(await dmRows()).toEqual([]);
  });

  it('sends no result DM while the game is still running', async () => {
    const { alice, game } = await aliceToMove();
    await dm(alice.id, game.id, 'result');
    await drain();
    expect(fake.callsTo('sendMessage')).toEqual([]);
  });

  it('records a DM sent after the player already moved as waiting', async () => {
    const { alice, game } = await aliceToMove();
    fake.onSend = async () => {
      await insertMove(db, game.id, 2, 'e7e5', 'e5', AFTER_E5);
      await db.update(games).set({ fen: AFTER_E5, plyCount: 2 }).where(eq(games.id, game.id));
    };
    await dm(alice.id, game.id, 'turn');
    await drain();
    expect(await dmRows()).toMatchObject([
      { kind: 'waiting', stub: '✓ You played 1... e5 · waiting for Bob' },
    ]);
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({
      chat_id: 11,
      text: '✓ You played 1... e5 · waiting for Bob',
    });
  });

  it('retires a DM that lands after the game ended', async () => {
    const { alice, game } = await aliceToMove();
    fake.onSend = async () => {
      await db
        .update(games)
        .set({ status: 'finished', result: '1-0', endReason: 'resignation' })
        .where(eq(games.id, game.id));
    };
    await dm(alice.id, game.id, 'turn');
    await drain();
    expect(await dmRows()).toEqual([]);
    expect(fake.callsTo('deleteMessage').map((call) => call.body)).toEqual([
      { chat_id: 11, message_id: 101 },
    ]);
  });

  it('keeps the draw offer line on a reminder', async () => {
    const { alice, game } = await aliceToMove({ drawOfferBy: 'white', drawOfferPly: 1 });
    await db
      .update(games)
      .set({ deadlineAt: sql`now() + interval '7 hours 30 minutes'` })
      .where(eq(games.id, game.id));
    await dm(alice.id, game.id, 'reminder');
    await drain();
    expect(fake.callsTo('sendMessage')[0]?.body.text).toBe(
      '7 h left for your move vs Bob\n\nBob offers a draw.',
    );
  });

  it('does not repeat a premoves-cancelled line from an earlier turn', async () => {
    const { alice, game } = await aliceToMove();
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'turn', gameId: game.id, premovesCancelledAtPly: 0 },
    });
    await drain();
    expect(fake.callsTo('sendMessage')[0]?.body.text).toBe('Your move vs Bob · 1. e4 · 23 h left');
  });

  it('edits a DM sent moments ago instead of notifying again', async () => {
    const { alice, game } = await aliceToMove({ drawOfferBy: 'white', drawOfferPly: 1 });
    await recordDm(db, {
      userId: alice.id,
      chatId: 11,
      gameId: game.id,
      telegramMessageId: 55,
      kind: 'turn',
      stub: 'Game vs Bob ended',
    });
    await dm(alice.id, game.id, 'draw_offer');
    await drain();
    expect(fake.callsTo('sendMessage')).toEqual([]);
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({
      chat_id: 11,
      message_id: 55,
      text: 'Bob offers a draw · 1. e4 · 23 h left',
    });
    expect(await dmRows()).toMatchObject([{ telegramMessageId: 55, kind: 'draw_offer' }]);
  });

  it('notifies again when the live DM is older than ten seconds', async () => {
    const { alice, game } = await aliceToMove({ drawOfferBy: 'white', drawOfferPly: 1 });
    await recordDm(db, {
      userId: alice.id,
      chatId: 11,
      gameId: game.id,
      telegramMessageId: 55,
      kind: 'turn',
      stub: 'Game vs Bob ended',
    });
    await db.update(dmMessages).set({ sentAt: sql`now() - interval '11 seconds'` });
    await dm(alice.id, game.id, 'draw_offer');
    await drain();
    expect(fake.callsTo('sendMessage')).toHaveLength(1);
    expect(fake.callsTo('deleteMessage').map((call) => call.body.message_id)).toEqual([55]);
  });

  it('keeps a DM as it is when state moved on without the player moving', async () => {
    const { alice, game } = await aliceToMove();
    // Somehow no longer Alice's move, yet she has no move of her own to show.
    fake.onSend = async () => {
      await db.update(games).set({ fen: AFTER_E5 }).where(eq(games.id, game.id));
    };
    await dm(alice.id, game.id, 'turn');
    await drain();
    expect(await dmRows()).toMatchObject([{ kind: 'turn' }]);
    expect(fake.callsTo('editMessageText')).toEqual([]);
  });

  it('deletes a sent DM that could not be recorded, so a retry does not leave two', async () => {
    const { alice, game } = await aliceToMove();
    fake.onSend = async () => {
      await db.delete(moves).where(eq(moves.gameId, game.id));
      await db.delete(games).where(eq(games.id, game.id));
    };
    await dm(alice.id, game.id, 'turn');
    await worker.runOnce();
    expect(fake.callsTo('deleteMessage').map((call) => call.body)).toEqual([
      { chat_id: 11, message_id: 101 },
    ]);
  });

  it('forgets the live rows of a user who blocked the bot', async () => {
    const { alice, game } = await aliceToMove();
    await dm(alice.id, game.id, 'turn');
    await drain();
    // Old enough that the reminder is sent as a new DM rather than edited into this one.
    await db.update(dmMessages).set({ sentAt: sql`now() - interval '1 minute'` });
    fake.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await dm(alice.id, game.id, 'reminder');
    await drain();
    expect(await dmRows()).toEqual([]);
  });
});

describe('send_welcome and send_message', () => {
  it('posts and pins the welcome card and stores its id', async () => {
    const { group } = await people();
    await enqueue(db, { kind: 'send_welcome', payload: { groupId: group.id } });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: '⚔️ Challenge someone',
            url: `https://t.me/TestChessBot/chess?startapp=n_${group.publicId}`,
          },
        ],
        [
          {
            text: '♟ Group lobby',
            url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
          },
        ],
      ],
    });
    expect(fake.callsTo('pinChatMessage')[0]?.body).toMatchObject({
      chat_id: CHAT,
      message_id: 101,
      disable_notification: true,
    });
    expect((await db.select().from(groups))[0]?.welcomeMessageId).toBe(101);
  });

  it('sends a one-line reply in the thread and marks the group left when the bot was kicked', async () => {
    await people();
    await enqueue(db, {
      kind: 'send_message',
      payload: { chatId: CHAT, threadId: 5, text: 'Nope.', replyToMessageId: 44 },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: CHAT,
      message_thread_id: 5,
      text: 'Nope.',
      reply_parameters: { message_id: 44, allow_sending_without_reply: true },
    });
    fake.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was kicked from the supergroup chat',
    });
    await enqueue(db, {
      kind: 'send_message',
      payload: { chatId: CHAT, threadId: null, text: 'Hi' },
    });
    await worker.runOnce();
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
  });

  it('deletes a message when its delete_message job is due, and finishes when it is already gone', async () => {
    await people();
    await enqueue(db, { kind: 'delete_message', payload: { chatId: CHAT, messageId: 55 } });
    await worker.runOnce();
    expect(fake.callsTo('deleteMessage')[0]?.body).toMatchObject({ chat_id: CHAT, message_id: 55 });
    fake.failNext('deleteMessage', {
      error_code: 400,
      description: 'Bad Request: message to delete not found',
    });
    await enqueue(db, { kind: 'delete_message', payload: { chatId: CHAT, messageId: 56 } });
    await worker.runOnce();
    const rows = (await jobRows()).filter((job) => job.kind === 'delete_message');
    expect(rows.map((job) => job.doneAt !== null)).toEqual([true, true]);
  });

  it("stacks a line's buttons one per row", async () => {
    await people();
    const buttons = [
      { text: 'One', url: 'https://t.me/a' },
      { text: 'Two', url: 'https://t.me/b' },
    ];
    await enqueue(db, {
      kind: 'send_message',
      payload: { chatId: CHAT, threadId: null, text: 'Pick', buttons },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body.reply_markup).toEqual({
      inline_keyboard: [[buttons[0]], [buttons[1]]],
    });
  });
});
