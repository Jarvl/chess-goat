import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Bot } from 'grammy';
import type { InlineKeyboardMarkup, MessageEntity } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { promptView } from '../../src/bot/challengePrompt';
import { webhookRoutes } from '../../src/bot/webhook';
import {
  challengePrompts,
  challenges,
  games,
  groupMembers,
  groups,
  jobs,
  telegramUpdates,
  users,
} from '../../src/db/schema';
import { updateGroupSettings } from '../../src/domain/groups';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import {
  callbackUpdate,
  chatMemberUpdate,
  commandUpdate,
  myChatMemberUpdate,
  privateChat,
  promptReplyUpdate,
  serviceUpdate,
  supergroup,
  tgUser,
} from '../helpers/updates';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let bot: Bot;
let app: Hono;
let metrics: Metrics;
const config = testConfig();

const chat = supergroup(-1001000000001);
const alice = tgUser(11, 'Alice', 'alice');
const bob = tgUser(22, 'Bob');
const carol = tgUser(33, 'Carol', 'carol');

beforeAll(async () => {
  fake = await FakeTelegram.start();
});
// A bot per test: its link rate limiter and its metrics start empty every time.
beforeEach(async () => {
  await truncateAll(db);
  metrics = new Metrics();
  bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config, metrics));
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: unknown, secret: string | null = config.WEBHOOK_SECRET) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(update),
  });
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
/** Every sighting of a person may queue a photo check; these tests are about the other effects. */
const effectJobs = async () => (await jobRows()).filter((job) => job.kind !== 'fetch_user_photo');
const messagesSent = async () =>
  (await jobRows()).filter((job) => job.kind === 'send_message').map((job) => job.payload);

describe('webhook', () => {
  it('rejects a missing or wrong secret and records nothing', async () => {
    expect(
      (await post(commandUpdate({ chat, from: alice, text: '/challenge' }), null)).status,
    ).toBe(401);
    expect(
      (await post(commandUpdate({ chat, from: alice, text: '/challenge' }), 'nope')).status,
    ).toBe(401);
    expect(await db.select().from(telegramUpdates)).toHaveLength(0);
  });

  it('acknowledges a duplicate update without repeating its effects', async () => {
    const update = challengeBob();
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect((await effectJobs()).map((job) => job.kind)).toEqual(['send_challenge_card', 'send_dm']);
    expect((await db.select().from(telegramUpdates)).map((row) => row.updateId)).toEqual([
      update.update_id,
    ]);
    expect((await db.select().from(telegramUpdates))[0]?.processedAt).not.toBeNull();
    // Both deliveries are counted; only the first had effects.
    expect(await metrics.render()).toContain('webhook_updates_total{type="message"} 2');
  });

  it('reprocesses an update whose earlier attempt never finished, but not one still in flight', async () => {
    const update = challengeBob();
    await db.insert(telegramUpdates).values({ updateId: update.update_id });
    expect((await post(update)).status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(0);

    await db
      .update(telegramUpdates)
      .set({ receivedAt: sql`now() - interval '2 minutes'` })
      .where(eq(telegramUpdates.updateId, update.update_id));
    expect((await post(update)).status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect((await db.select().from(telegramUpdates))[0]?.processedAt).not.toBeNull();
  });
});

/** `/challenge Bob`, picking Bob (who has no username) from the mention list. */
const challengeBob = () =>
  commandUpdate({
    chat,
    from: alice,
    text: '/challenge Bob',
    entities: [{ type: 'text_mention', offset: 11, length: 3, user: bob }],
  });

const PROMPT = 'Who do you want to play? Type @ and pick them from the list, or tap Anyone.';
const sends = () => fake.callsTo('sendMessage').map((call) => call.body);
const texts = () => sends().map((body) => body.text);
const makeAdmin = () =>
  post(myChatMemberUpdate({ chat, from: alice, oldStatus: 'left', newStatus: 'administrator' }));
/** The newest delete_message job, due about `seconds` from now, for the message the bot just sent. */
const expectDeletionIn = async (kind: 'delete_message', seconds: number) => {
  const [row] = (await jobRows()).filter((job) => job.kind === kind);
  expect(row?.payload).toEqual({ chatId: chat.id, messageId: expect.any(Number) });
  const due = (row!.runAt.getTime() - Date.now()) / 1000;
  expect(due).toBeGreaterThan(seconds - 10);
  expect(due).toBeLessThanOrEqual(seconds);
};
const promptRows = () => db.select().from(challengePrompts);
const userId = async (telegramUserId: number) =>
  (await db.select().from(users).where(eq(users.telegramUserId, telegramUserId)))[0]!.id;
/** The prompt's keyboard as first sent, which Telegram may still hand back after edits. */
const staleMarkup = (owner = alice.id) =>
  promptView('main', owner, { timePerMove: 259200, colour: 'random', rated: true })
    .replyMarkup as InlineKeyboardMarkup;
const tap = (data: string, from = alice, extra: { threadId?: number } = {}) =>
  post(
    callbackUpdate({
      from,
      chat,
      data,
      ephemeralMessageId: 300,
      markup: staleMarkup(),
      ...extra,
    }),
  );
/** A reply to the private prompt, which arrives as an ephemeral message. */
const promptReply = (
  text: string,
  entities: MessageEntity[] = [],
  options: { from?: typeof alice; threadId?: number } = {},
) =>
  promptReplyUpdate({
    chat,
    from: options.from ?? alice,
    text,
    entities,
    prompt: { markup: staleMarkup(), ephemeralMessageId: 300 },
    ephemeral: true,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
const mentionAt0 = (name: string): MessageEntity[] => [
  { type: 'mention', offset: 0, length: name.length },
];

describe('/challenge', () => {
  it('creates a direct challenge from a mention inside the topic and records both members', async () => {
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge@TestChessBot Bob',
        entities: [{ type: 'text_mention', offset: 22, length: 3, user: bob }],
        threadId: 77,
      }),
    );
    const [challenge] = await db.select().from(challenges);
    const people = await db
      .select()
      .from(users)
      .where(eq(users.isEngine, false))
      .orderBy(users.telegramUserId);
    expect(people.map((u) => [u.telegramUserId, u.firstName, u.username])).toEqual([
      [11, 'Alice', 'alice'],
      [22, 'Bob', null],
    ]);
    expect(challenge).toMatchObject({
      challengerId: people[0]!.id,
      opponentId: people[1]!.id,
      threadId: 77,
      timePerMove: 259200,
      rated: true,
      challengerColour: 'random',
    });
    expect(await db.select().from(groupMembers)).toHaveLength(2);
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(chat.id);
  });

  it('opens a private prompt for a bare /challenge from an admin bot, and deletes the command', async () => {
    await makeAdmin();
    const update = commandUpdate({ chat, from: alice, text: '/challenge' });
    await post(update);
    expect(sends()).toHaveLength(1);
    const body = sends()[0]!;
    expect(body).toMatchObject({
      chat_id: chat.id,
      ephemeral_message_parameters: { receiver_user_id: alice.id },
      reply_markup: { force_reply: true },
    });
    expect(body).not.toHaveProperty('reply_parameters');
    expect(body.text).toBe(`${PROMPT}\n3 days per move · Random colour · Rated`);
    expect(
      (body.reply_markup as InlineKeyboardMarkup).inline_keyboard[0]!.map((b) => [
        b.text,
        (b as { callback_data: string }).callback_data,
      ]),
    ).toEqual([
      ['Anyone', 'cp/a/11/3/r/1'],
      ['Game settings', 'cp/s/11/3/r/1'],
    ]);
    expect(fake.callsTo('deleteMessage').map((call) => call.body)).toEqual([
      { chat_id: chat.id, message_id: update.message!.message_id },
    ]);
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await messagesSent()).toEqual([]);
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 259200, colour: 'random', rated: true }),
    ]);
  });

  it('posts the prompt in the group, naming its owner, when the bot is no admin', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    await post(commandUpdate({ chat, from: bob, text: '/challenge' }));
    const [forAlice, forBob] = sends();
    expect(forAlice).not.toHaveProperty('ephemeral_message_parameters');
    expect(forAlice).toMatchObject({
      chat_id: chat.id,
      message_thread_id: 77,
      text: `@alice\n${PROMPT}\n3 days per move · Random colour · Rated`,
      reply_markup: { force_reply: true },
    });
    expect((forAlice!.reply_markup as InlineKeyboardMarkup).inline_keyboard[0]![0]).toMatchObject({
      callback_data: 'cp/a/11/3/r/1',
    });
    // Bob has no username: his name links to him instead.
    expect(forBob).toMatchObject({
      text: `Bob\n${PROMPT}\n3 days per move · Random colour · Rated`,
      entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: bob.id } }],
    });
    expect(fake.callsTo('deleteMessage')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('posts the prompt in the group when Telegram refuses the private one', async () => {
    await makeAdmin();
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).not.toHaveProperty('ephemeral_message_parameters');
    expect(sends()[1]?.text).toBe(`@alice\n${PROMPT}\n3 days per move · Random colour · Rated`);
    await expectDeletionIn('delete_message', 600);
  });

  it('works the fallback prompt with normal edits and deletes', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(
      callbackUpdate({
        from: alice,
        chat,
        data: 'cp/s/11/3/r/1',
        cardMessageId: 101,
        markup: staleMarkup(),
      }),
    );
    const edit = fake.callsTo('editMessageText').at(-1)!.body;
    expect(edit).toMatchObject({ chat_id: chat.id, message_id: 101 });
    expect(
      (edit.reply_markup as InlineKeyboardMarkup).inline_keyboard.map((row) =>
        row.map((b) => b.text),
      ),
    ).toEqual([
      ['1 day', '3 days', '7 days'],
      ['Random', 'White', 'Black'],
      ['Rated', 'Casual'],
      ['Done'],
    ]);
    expect(fake.callsTo('editEphemeralMessageText')).toHaveLength(0);
    await post(
      callbackUpdate({
        from: alice,
        chat,
        data: 'cp/a/11/3/r/1',
        cardMessageId: 101,
        markup: staleMarkup(),
      }),
    );
    expect(fake.callsTo('deleteMessage').map((call) => call.body)).toEqual([
      { chat_id: chat.id, message_id: 101 },
    ]);
    expect(fake.callsTo('deleteEphemeralMessage')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(await promptRows()).toEqual([]);
  });

  it('ignores another member replying to, or tapping, the fallback prompt', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(
      callbackUpdate({
        from: carol,
        chat,
        data: 'cp/a/11/3/r/1',
        cardMessageId: 101,
        markup: staleMarkup(),
      }),
    );
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only @alice can use this.',
      show_alert: true,
    });
    await post(
      promptReplyUpdate({
        chat,
        from: carol,
        text: '@dave',
        entities: mentionAt0('@dave'),
        prompt: { markup: staleMarkup(), messageId: 101 },
      }),
    );
    expect(sends()).toHaveLength(1);
    expect(fake.callsTo('editMessageText')).toHaveLength(0);
    expect(fake.callsTo('deleteMessage')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await promptRows()).toHaveLength(1);
  });

  it('falls back to a public refusal that deletes itself after a minute', async () => {
    await makeAdmin();
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    const update = commandUpdate({
      chat,
      from: alice,
      text: '/challenge @alice',
      entities: [{ type: 'mention', offset: 11, length: 6 }],
    });
    await post(update);
    expect(sends()[1]).toMatchObject({
      text: "You can't challenge yourself.",
      reply_parameters: { message_id: update.message!.message_id },
    });
    expect(sends()[1]).not.toHaveProperty('ephemeral_message_parameters');
    await expectDeletionIn('delete_message', 60);
  });

  it("keeps a topic-less stored prompt from overriding the tapped message's topic", async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(
      callbackUpdate({
        from: alice,
        chat,
        data: 'cp/a/11/3/r/1',
        cardMessageId: 101,
        markup: staleMarkup(),
        threadId: 77,
      }),
    );
    expect((await db.select().from(challenges))[0]?.threadId).toBe(77);
  });

  it("opens a prompt for a bare /challenge that replies to the bot's own message", async () => {
    const me = { id: 424242, is_bot: true, first_name: 'Test Chess', username: 'TestChessBot' };
    await post(commandUpdate({ chat, from: alice, text: '/challenge', replyTo: { from: me } }));
    expect(texts()).toEqual([`@alice\n${PROMPT}\n3 days per move · Random colour · Rated`]);
    expect(await promptRows()).toHaveLength(1);
  });

  it('opens the prompt, whatever a bare /challenge replies to', async () => {
    const update = commandUpdate({
      chat,
      from: alice,
      text: '/challenge',
      replyTo: { from: bob },
      threadId: 77,
    });
    Object.assign(update.message!.reply_to_message!, {
      message_id: 77,
      forum_topic_created: { name: 'Games', icon_color: 1 },
    });
    await post(update);
    // A reply to a person, an anonymous author or yourself is no longer a way to name an opponent.
    for (const replyTo of [{ from: bob }, { senderChat: true }, { from: alice }])
      await post(commandUpdate({ chat, from: alice, text: '/challenge', replyTo }));
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(texts()).toHaveLength(4);
    texts().forEach((text) => expect(text).toContain(PROMPT));
  });

  it('edits the prompt to the settings view and back, carrying the chosen settings', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await tap('cp/s/11/3/r/1');
    let edit = fake.callsTo('editEphemeralMessageText').at(-1)!.body;
    expect(edit).toMatchObject({
      chat_id: chat.id,
      receiver_user_id: alice.id,
      ephemeral_message_id: 300,
      reply_markup: { force_reply: true },
    });
    expect(
      (edit.reply_markup as InlineKeyboardMarkup).inline_keyboard.map((row) =>
        row.map((b) => b.text),
      ),
    ).toEqual([
      ['1 day', '3 days', '7 days'],
      ['Random', 'White', 'Black'],
      ['Rated', 'Casual'],
      ['Done'],
    ]);
    await tap('cp/s/11/7/b/1');
    edit = fake.callsTo('editEphemeralMessageText').at(-1)!.body;
    expect(edit.text).toBe(`${PROMPT}\n7 days per move · You play Black · Rated`);
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 604800, colour: 'black', rated: true }),
    ]);
    await tap('cp/m/11/7/b/1');
    edit = fake.callsTo('editEphemeralMessageText').at(-1)!.body;
    expect(
      (edit.reply_markup as InlineKeyboardMarkup).inline_keyboard[0]!.map(
        (b) => (b as { callback_data: string }).callback_data,
      ),
    ).toEqual(['cp/a/11/7/b/1', 'cp/s/11/7/b/1']);
    expect(fake.callsTo('answerCallbackQuery')).toHaveLength(3);
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).not.toHaveProperty('text');
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('keeps the stored settings when the prompt edit fails, but saves on "not modified"', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    fake.failNext('editEphemeralMessageText', {
      error_code: 400,
      description: 'Bad Request: BUTTON_DATA_INVALID',
    });
    await tap('cp/s/11/7/b/0');
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 259200, colour: 'random', rated: true }),
    ]);
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Something went wrong. Try again.',
    });
    fake.failNext('editEphemeralMessageText', {
      error_code: 400,
      description: 'Bad Request: message is not modified',
    });
    await tap('cp/s/11/7/b/0');
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 604800, colour: 'black', rated: false }),
    ]);
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).not.toHaveProperty('text');
  });

  it('keeps the stored settings when the fallback prompt edit fails', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    fake.failNext('editMessageText', {
      error_code: 400,
      description: 'Bad Request: BUTTON_DATA_INVALID',
    });
    await post(
      callbackUpdate({
        from: alice,
        chat,
        data: 'cp/s/11/7/b/0',
        cardMessageId: 101,
        markup: staleMarkup(),
      }),
    );
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 259200, colour: 'random', rated: true }),
    ]);
  });

  it('creates one challenge from two Anyone taps, or an Anyone tap and a reply', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await Promise.all([tap('cp/a/11/3/r/1'), tap('cp/a/11/3/r/1')]);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(fake.callsTo('answerCallbackQuery')).toHaveLength(2);
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await tap('cp/a/11/3/r/1');
    await post(promptReply('@dave', mentionAt0('@dave')));
    expect(await db.select().from(challenges)).toHaveLength(2);
    expect(await promptRows()).toEqual([]);
  });

  it('creates an open challenge from Anyone with the prompt settings and deletes the prompt', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await tap('cp/s/11/7/b/0');
    await tap('cp/a/11/7/b/0');
    expect(await db.select().from(challenges)).toEqual([
      expect.objectContaining({
        opponentId: null,
        opponentUsername: null,
        timePerMove: 604800,
        challengerColour: 'black',
        rated: false,
      }),
    ]);
    expect(fake.callsTo('deleteEphemeralMessage').map((call) => call.body)).toEqual([
      { chat_id: chat.id, receiver_user_id: alice.id, ephemeral_message_id: 300 },
    ]);
    expect(await promptRows()).toEqual([]);
    expect((await effectJobs()).map((job) => job.kind)).toContain('send_challenge_card');
  });

  it("tells a member who taps someone else's prompt whose it is", async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await tap('cp/a/11/3/r/1', carol);
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only @alice can use this.',
      show_alert: true,
    });
    await tap('cp/s/99/3/r/1', carol);
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only the person who asked can use this.',
    });
    expect(fake.callsTo('editEphemeralMessageText')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('challenges the member picked in a reply, known, unseen (by username) or without a username', async () => {
    await makeAdmin();
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await tap('cp/s/11/1/w/0');
    // The reply's copy of the prompt still shows the starting keyboard; the stored settings win.
    const reply = promptReply('@carol', mentionAt0('@carol'));
    await post(reply);
    expect(await db.select().from(challenges)).toEqual([
      expect.objectContaining({
        opponentId: await userId(carol.id),
        timePerMove: 86400,
        challengerColour: 'white',
        rated: false,
      }),
    ]);
    expect(fake.callsTo('deleteEphemeralMessage').map((call) => call.body)).toEqual([
      { chat_id: chat.id, receiver_user_id: alice.id, ephemeral_message_id: 300 },
    ]);
    expect(await promptRows()).toEqual([]);

    // A fresh prompt each time: the starting settings apply.
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(promptReply('hi @Dave', [{ type: 'mention', offset: 3, length: 5 }]));
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(promptReply('Bob', [{ type: 'text_mention', offset: 0, length: 3, user: bob }]));
    const [, byUsername, byTextMention] = await db.select().from(challenges).orderBy(challenges.id);
    expect(byUsername).toMatchObject({
      opponentId: null,
      opponentUsername: 'dave',
      timePerMove: 259200,
      challengerColour: 'random',
      rated: true,
    });
    expect(byTextMention?.opponentId).toBe(await userId(bob.id));
    expect(await messagesSent()).toEqual([]);
  });

  it('refuses a bot or yourself picked in a reply, privately, and keeps the prompt', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    const replies = [
      promptReply('@TestChessBot', mentionAt0('@TestChessBot')),
      promptReply('@helper_bot', mentionAt0('@helper_bot')),
      promptReply('@Alice', mentionAt0('@Alice')),
      promptReply('Helper', [
        { type: 'text_mention', offset: 0, length: 6, user: { ...bob, is_bot: true } },
      ]),
      promptReply('Alice', [{ type: 'text_mention', offset: 0, length: 5, user: alice }]),
    ];
    for (const reply of replies) await post(reply);
    const answers = sends().slice(1);
    expect(answers.map((body) => body.text)).toEqual([
      "Bots don't play here.",
      "Bots don't play here.",
      "You can't challenge yourself.",
      "Bots don't play here.",
      "You can't challenge yourself.",
    ]);
    answers.forEach((body, i) =>
      expect(body).toMatchObject({
        reply_parameters: {
          ephemeral_message_id: (replies[i]!.message as { ephemeral_message_id: number })
            .ephemeral_message_id,
        },
        ephemeral_message_parameters: { receiver_user_id: alice.id },
      }),
    );
    expect(fake.callsTo('deleteEphemeralMessage')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await promptRows()).toHaveLength(1);
  });

  it('tells the owner privately to pick someone when the reply names nobody', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    await post(promptReply('carol'));
    expect(sends().at(-1)).toMatchObject({
      text: 'Type @ in your reply and pick who you want to play from the list.',
      ephemeral_message_parameters: { receiver_user_id: alice.id },
    });
    // Someone else replying to Alice's prompt is ignored.
    await post(promptReply('@carol', mentionAt0('@carol'), { from: carol }));
    expect(sends()).toHaveLength(2);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('answers a reply to the group prompt with a normal reply', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    const reply = promptReplyUpdate({
      chat,
      from: alice,
      text: 'carol',
      prompt: { markup: staleMarkup(), messageId: 101 },
    });
    await post(reply);
    const answer = sends().at(-1)!;
    expect(answer).not.toHaveProperty('ephemeral_message_parameters');
    expect(answer).toMatchObject({
      text: 'Type @ in your reply and pick who you want to play from the list.',
      reply_parameters: { message_id: reply.message!.message_id },
    });
    await post(
      promptReplyUpdate({
        chat,
        from: alice,
        text: '@dave',
        entities: mentionAt0('@dave'),
        prompt: { markup: staleMarkup(), messageId: 101 },
      }),
    );
    expect((await db.select().from(challenges))[0]?.opponentUsername).toBe('dave');
  });

  it('posts /challenge @name at once with 3 days, random colour and the group rated default', async () => {
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    const [group] = await db.select().from(groups);
    await updateGroupSettings(db, group!.id, { defaultTimePerMove: 86400, ratedDefault: false });
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge @carol',
        entities: [{ type: 'mention', offset: 11, length: 6 }],
      }),
    );
    expect(await db.select().from(challenges)).toEqual([
      expect.objectContaining({
        opponentId: await userId(carol.id),
        timePerMove: 259200,
        challengerColour: 'random',
        rated: false,
      }),
    ]);
    expect(sends()).toEqual([]);
    expect(await promptRows()).toEqual([]);
  });

  it('ignores replies to cards and to other bot messages', async () => {
    await post(challengeBob());
    fake.reset();
    const card: InlineKeyboardMarkup = {
      inline_keyboard: [[{ text: 'Accept', callback_data: 'ch/acc/AAAAAAAAAA' }]],
    };
    for (const markup of [card, { inline_keyboard: [] }]) {
      await post(
        promptReplyUpdate({
          chat,
          from: alice,
          text: '@carol',
          entities: mentionAt0('@carol'),
          prompt: { markup, messageId: 900 },
        }),
      );
    }
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(fake.calls).toEqual([]);
  });

  it('posts the card in the reply topic, or the fixed topic when configured', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    await post(promptReply('@dave', mentionAt0('@dave'), { threadId: 77 }));
    const [group] = await db.select().from(groups);
    await updateGroupSettings(db, group!.id, { cardTopicMode: 'fixed', fixedTopicId: 5 });
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    await post(promptReply('@erin', mentionAt0('@erin'), { threadId: 77 }));
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    await tap('cp/a/11/3/r/1');
    expect(
      (await db.select().from(challenges).orderBy(challenges.id)).map((row) => row.threadId),
    ).toEqual([77, 5, 5]);
  });

  it("puts the card in the prompt's topic when the tap or the reply doesn't say which", async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    expect(await promptRows()).toEqual([expect.objectContaining({ threadId: 77 })]);
    // The tap carries no topic.
    await tap('cp/a/11/3/r/1');
    await post(commandUpdate({ chat, from: alice, text: '/challenge', threadId: 77 }));
    // Nor does this reply.
    await post(promptReply('@dave', mentionAt0('@dave')));
    expect(
      (await db.select().from(challenges).orderBy(challenges.id)).map((row) => row.threadId),
    ).toEqual([77, 77]);
  });

  it('keeps the prompt and answers privately when Anyone hits the pending limit or open challenges are off', async () => {
    await makeAdmin();
    await post(commandUpdate({ chat, from: alice, text: '/challenge' }));
    const [group] = await db.select().from(groups);
    await updateGroupSettings(db, group!.id, { allowOpenChallenges: false });
    await tap('cp/a/11/3/r/1');
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Open challenges are off in this group.',
      show_alert: true,
    });
    await updateGroupSettings(db, group!.id, { allowOpenChallenges: true });
    const a = await userId(alice.id);
    for (let i = 0; i < 3; i += 1) await insertChallenge(db, group!.id, a, null);
    await tap('cp/a/11/3/r/1');
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'You already have 3 pending challenges here.',
    });
    expect(fake.callsTo('deleteEphemeralMessage')).toHaveLength(0);
    expect(await db.select().from(challenges)).toHaveLength(3);
    expect(await promptRows()).toEqual([
      expect.objectContaining({ timePerMove: 259200, colour: 'random', rated: true }),
    ]);
  });

  it('refuses a self-challenge or a bot named in a normal message, as a public reply', async () => {
    const mention = (name: string) =>
      commandUpdate({
        chat,
        from: alice,
        text: `/challenge ${name}`,
        entities: [{ type: 'mention', offset: 11, length: name.length }],
      });
    const updates = [mention('@alice'), mention('@other_bot')];
    for (const update of updates) await post(update);
    expect(texts()).toEqual(["You can't challenge yourself.", "Bots don't play here."]);
    sends().forEach((body, i) => {
      expect(body).not.toHaveProperty('ephemeral_message_parameters');
      expect(body).toMatchObject({
        reply_parameters: { message_id: updates[i]!.message!.message_id },
      });
    });
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await messagesSent()).toEqual([]);
  });

  it('refuses privately, and deletes the command, when the bot is an admin', async () => {
    await makeAdmin();
    const update = commandUpdate({
      chat,
      from: alice,
      text: '/challenge @alice',
      entities: [{ type: 'mention', offset: 11, length: 6 }],
    });
    await post(update);
    expect(sends()).toEqual([
      expect.objectContaining({
        text: "You can't challenge yourself.",
        ephemeral_message_parameters: { receiver_user_id: alice.id },
      }),
    ]);
    expect(sends()[0]).not.toHaveProperty('reply_parameters');
    expect(fake.callsTo('deleteMessage').map((call) => call.body.message_id)).toEqual([
      update.message!.message_id,
    ]);
  });

  it('ignores commands addressed to another bot', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/challenge@OtherBot' }));
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });
  it('ignores /play, which is not a command', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play' }));
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });

  it('challenges a member named by @username, whatever its case', async () => {
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge @Carol',
        entities: [{ type: 'mention', offset: 11, length: 6 }],
      }),
    );
    const [challenge] = await db.select().from(challenges);
    const [carolRow] = await db.select().from(users).where(eq(users.telegramUserId, carol.id));
    expect(challenge?.opponentId).toBe(carolRow!.id);
  });

  it('challenges someone picked from the mention list, who may have no username', async () => {
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge Bob',
        entities: [{ type: 'text_mention', offset: 11, length: 3, user: bob }],
      }),
    );
    const [challenge] = await db.select().from(challenges);
    const [bobRow] = await db.select().from(users).where(eq(users.telegramUserId, bob.id));
    expect(challenge?.opponentId).toBe(bobRow!.id);
    expect(await db.select().from(groupMembers)).toHaveLength(2);
  });

  it('challenges the mentioned person, and a reply target alone opens the prompt', async () => {
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge @carol',
        replyTo: { from: bob },
        entities: [{ type: 'mention', offset: 11, length: 6 }],
      }),
    );
    const [carolRow] = await db.select().from(users).where(eq(users.telegramUserId, carol.id));
    expect((await db.select().from(challenges))[0]?.opponentId).toBe(carolRow!.id);
    expect(sends()).toEqual([]);
    await post(commandUpdate({ chat, from: alice, text: '/challenge', replyTo: { from: bob } }));
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(texts()).toEqual([`@alice\n${PROMPT}\n3 days per move · Random colour · Rated`]);
  });

  it('answers an ephemeral bare /challenge with a private prompt, admin or not', async () => {
    for (const admin of [false, true]) {
      if (admin) await makeAdmin();
      fake.reset();
      await db.delete(challengePrompts);
      const update = commandUpdate({ chat, from: alice, text: '/challenge', ephemeral: true });
      await post(update);
      expect(sends()).toHaveLength(1);
      const body = sends()[0]!;
      expect(body).toMatchObject({
        chat_id: chat.id,
        reply_parameters: { ephemeral_message_id: update.message!.ephemeral_message_id },
        ephemeral_message_parameters: { receiver_user_id: alice.id },
        text: `${PROMPT}\n3 days per move · Random colour · Rated`,
      });
      expect(
        (body.reply_markup as InlineKeyboardMarkup).inline_keyboard[0]!.map(
          (b) => (b as { callback_data: string }).callback_data,
        ),
      ).toEqual(['cp/a/11/3/r/1', 'cp/s/11/3/r/1']);
      expect(fake.callsTo('deleteMessage')).toHaveLength(0);
      expect(await promptRows()).toHaveLength(1);
    }
  });

  it('refuses an ephemeral /challenge @name privately, admin or not', async () => {
    for (const admin of [false, true]) {
      if (admin) await makeAdmin();
      fake.reset();
      const update = commandUpdate({
        chat,
        from: alice,
        text: '/challenge @SomeBot',
        entities: [{ type: 'mention', offset: 11, length: 8 }],
        ephemeral: true,
      });
      await post(update);
      expect(sends()).toEqual([
        expect.objectContaining({
          text: "Bots don't play here.",
          reply_parameters: { ephemeral_message_id: update.message!.ephemeral_message_id },
          ephemeral_message_parameters: { receiver_user_id: alice.id },
        }),
      ]);
      expect(fake.callsTo('deleteMessage')).toHaveLength(0);
      expect((await jobRows()).filter((job) => job.kind === 'send_message')).toEqual([]);
    }
  });

  it('opens the prompt for an ephemeral /challenge sent as a reply, ignoring what it replies to', async () => {
    // Telegram sends none, but should it ever, the reply is not a way to name an opponent.
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/challenge',
        replyTo: { from: bob },
        ephemeral: true,
      }),
    );
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({
      text: `${PROMPT}\n3 days per move · Random colour · Rated`,
      ephemeral_message_parameters: { receiver_user_id: alice.id },
    });
    expect(await promptRows()).toHaveLength(1);
  });

  it('falls back to the public prompt when Telegram refuses the private answer to an ephemeral /challenge', async () => {
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    await post(commandUpdate({ chat, from: alice, text: '/challenge', ephemeral: true }));
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).not.toHaveProperty('ephemeral_message_parameters');
    expect(sends()[1]?.text).toBe(`@alice\n${PROMPT}\n3 days per move · Random colour · Rated`);
    expect(fake.callsTo('deleteMessage')).toHaveLength(0);
    await expectDeletionIn('delete_message', 600);
  });

  it('challenges a username it has not seen, and refuses bots and yourself by name', async () => {
    // Dan was here once and has left, which is as good as never seen.
    const dan = tgUser(44, 'Dan', 'dan');
    await post(serviceUpdate(chat, alice, { new_chat_members: [dan] }));
    await post(serviceUpdate(chat, dan, { left_chat_member: dan }));
    const mention = (name: string) =>
      commandUpdate({
        chat,
        from: alice,
        text: `/challenge ${name}`,
        entities: [{ type: 'mention', offset: 11, length: name.length }],
      });
    await post(mention('@Nobody'));
    await post(mention('@dan'));
    await post(mention('@TestChessBot'));
    await post(mention('@other_bot'));
    await post(mention('@alice'));
    expect(texts()).toEqual([
      "Bots don't play here.",
      "Bots don't play here.",
      "You can't challenge yourself.",
    ]);
    expect(
      (await db.select().from(challenges).orderBy(challenges.id)).map((row) => [
        row.opponentId,
        row.opponentUsername,
      ]),
    ).toEqual([
      [null, 'nobody'],
      [null, 'dan'],
    ]);
  });
});

describe('/chess, /settings and /start', () => {
  it('posts Challenge and lobby buttons', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/chess' }));
    const [group] = await db.select().from(groups);
    const sent = await messagesSent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: chat.id,
      text: 'Challenge someone in this group, or open the lobby for games and ratings.',
      buttons: [
        {
          text: '⚔️ Challenge someone',
          url: `https://t.me/TestChessBot/chess?startapp=n_${group!.publicId}`,
        },
        {
          text: '♟ Group lobby',
          url: `https://t.me/TestChessBot/chess?startapp=l_${group!.publicId}`,
        },
      ],
    });
  });

  it('sends /chess and /settings privately', async () => {
    const chess = commandUpdate({
      chat,
      from: alice,
      text: '/chess',
      ephemeral: true,
      threadId: 9,
    });
    await post(chess);
    await post(commandUpdate({ chat, from: alice, text: '/settings', ephemeral: true }));
    const [group] = await db.select().from(groups);
    expect(sends()[0]).toMatchObject({
      chat_id: chat.id,
      message_thread_id: 9,
      text: 'Challenge someone in this group, or open the lobby for games and ratings.',
      reply_parameters: {
        ephemeral_message_id: (chess.message as { ephemeral_message_id: number })
          .ephemeral_message_id,
      },
      ephemeral_message_parameters: { receiver_user_id: alice.id },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '⚔️ Challenge someone',
              url: `https://t.me/TestChessBot/chess?startapp=n_${group!.publicId}`,
            },
          ],
          [
            {
              text: '♟ Group lobby',
              url: `https://t.me/TestChessBot/chess?startapp=l_${group!.publicId}`,
            },
          ],
        ],
      },
    });
    expect(sends()[1]).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Open settings',
              url: `https://t.me/TestChessBot/chess?startapp=s_${group!.publicId}`,
            },
          ],
        ],
      },
    });
    expect(await messagesSent()).toEqual([]);

    // Refused: the usual message goes out instead.
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request' });
    await post(commandUpdate({ chat, from: alice, text: '/settings', ephemeral: true }));
    expect(await messagesSent()).toEqual([
      expect.objectContaining({ text: 'Group chess settings (admins only).' }),
    ]);
  });

  it('allows 20 links per person per group per minute, shared with /settings', async () => {
    const other = supergroup(-1001000000079);
    for (let i = 0; i < 20; i += 1) {
      await post(commandUpdate({ chat: other, from: alice, text: i % 2 ? '/settings' : '/chess' }));
    }
    await post(commandUpdate({ chat: other, from: alice, text: '/chess' }));
    await post(commandUpdate({ chat: other, from: bob, text: '/chess' }));
    await post(commandUpdate({ chat, from: alice, text: '/chess' }));
    expect(await messagesSent()).toHaveLength(22);
  });

  it('answers an anonymous admin without recording the anonymous bot as a member', async () => {
    const anonymousBot = { ...tgUser(1087968824, 'Group', 'GroupAnonymousBot'), is_bot: true };
    await post(commandUpdate({ chat, from: anonymousBot, text: '/chess', senderChat: true }));
    expect(await messagesSent()).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.isEngine, false))).toHaveLength(0);
  });

  it('posts an Open settings button', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/settings' }));
    const [group] = await db.select().from(groups);
    expect((await messagesSent())[0]).toMatchObject({
      buttons: [
        {
          text: 'Open settings',
          url: `https://t.me/TestChessBot/chess?startapp=s_${group!.publicId}`,
        },
      ],
    });
  });

  it('marks DMs allowed on /start in private and sends the Open Chess button there', async () => {
    await post(commandUpdate({ chat: privateChat(alice), from: alice, text: '/start' }));
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, alice.id));
    expect(user?.dmAllowed).toBe(true);
    expect((await messagesSent())[0]).toMatchObject({
      chatId: alice.id,
      buttons: [{ text: '♟ Open Chess', url: 'https://t.me/TestChessBot/chess' }],
    });
  });
});

describe('callbacks', () => {
  async function pendingChallenge() {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db, {
      telegramUserId: alice.id,
      firstName: 'Alice',
      username: 'alice',
    });
    const b = await insertUser(db, { telegramUserId: bob.id, firstName: 'Bob' });
    await touchMember(db, group.id, a.id);
    await touchMember(db, group.id, b.id);
    const challenge = await insertChallenge(db, group.id, a.id, b.id, { messageId: 900 });
    return { group, a, b, challenge };
  }

  it('lets the challenged player accept silently and tells anyone else who may', async () => {
    const { challenge } = await pendingChallenge();
    await post(callbackUpdate({ from: carol, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only Bob can accept this challenge.',
      show_alert: true,
    });
    expect(await db.select().from(games)).toHaveLength(0);
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).not.toHaveProperty('text');
    const [game] = await db.select().from(games);
    expect(game?.cardMessageId).toBe(900);
  });

  it('reports a challenge that someone else already accepted', async () => {
    const { challenge } = await pendingChallenge();
    await db.update(challenges).set({ status: 'accepted' }).where(eq(challenges.id, challenge.id));
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Someone accepted first.',
    });
  });

  it('refuses the challenger tapping Accept on their own open challenge', async () => {
    const { group, a } = await pendingChallenge();
    const open = await insertChallenge(db, group.id, a.id, null, { messageId: 901 });
    await post(callbackUpdate({ from: alice, chat, data: `ch/acc/${open.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: "You can't accept your own challenge.",
      show_alert: true,
    });
    expect(await db.select().from(games)).toHaveLength(0);
    expect((await db.select().from(challenges).where(eq(challenges.id, open.id)))[0]?.status).toBe(
      'pending',
    );
  });

  it('tells a bystander who may withdraw an open challenge', async () => {
    const { group, a } = await pendingChallenge();
    const open = await insertChallenge(db, group.id, a.id, null, { messageId: 902 });
    await post(callbackUpdate({ from: bob, chat, data: `ch/dec/${open.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only @alice can withdraw this challenge.',
      show_alert: true,
    });
    expect((await db.select().from(challenges).where(eq(challenges.id, open.id)))[0]?.status).toBe(
      'pending',
    );
  });

  it('treats Decline as a withdrawal for the challenger and a decline for the opponent', async () => {
    const first = await pendingChallenge();
    await post(callbackUpdate({ from: alice, chat, data: `ch/dec/${first.challenge.publicId}` }));
    expect(
      (await db.select().from(challenges).where(eq(challenges.id, first.challenge.id)))[0]?.status,
    ).toBe('cancelled');
    const second = await insertChallenge(db, first.group.id, first.a.id, first.b.id);
    await post(callbackUpdate({ from: bob, chat, data: `ch/dec/${second.publicId}` }));
    expect(
      (await db.select().from(challenges).where(eq(challenges.id, second.id)))[0]?.status,
    ).toBe('declined');
  });

  it('creates a reversed rematch for a player and refuses a spectator', async () => {
    const { group, a, b } = await pendingChallenge();
    const game = await insertGame(db, group.id, a.id, b.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      finishedAt: new Date(),
    });
    await post(callbackUpdate({ from: carol, chat, data: `gm/rem/${game.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only the players can ask for a rematch.',
    });
    await post(callbackUpdate({ from: bob, chat, data: `gm/rem/${game.publicId}` }));
    const rematch = (await db.select().from(challenges)).find((row) => row.challengerId === b.id);
    expect(rematch).toMatchObject({ opponentId: a.id, challengerColour: 'white' });
  });
});

describe('membership events', () => {
  it('welcomes the bot when it is added and marks it admin-capable', async () => {
    await post(
      myChatMemberUpdate({
        chat,
        from: alice,
        oldStatus: 'left',
        newStatus: 'administrator',
        canPin: true,
      }),
    );
    const [group] = await db.select().from(groups);
    expect(group).toMatchObject({ botStatus: 'administrator', botIsAdmin: true, botCanPin: true });
    expect((await effectJobs()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['send_welcome', `welcome:${group!.publicId}`],
    ]);
  });

  it('cancels pending challenges when the bot is removed', async () => {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertChallenge(db, group.id, a.id, b.id);
    await post(myChatMemberUpdate({ chat, from: alice, oldStatus: 'member', newStatus: 'kicked' }));
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
    expect((await db.select().from(challenges))[0]?.status).toBe('cancelled');
  });

  it('records joins and leaves from chat_member and service messages', async () => {
    await insertGroup(db, { telegramChatId: chat.id });
    await post(chatMemberUpdate({ chat, from: alice, user: bob, newStatus: 'member' }));
    let [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('member');
    expect(member?.verifiedAt).not.toBeNull();
    await post(serviceUpdate(chat, bob, { left_chat_member: bob }));
    [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('left');
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    expect(await db.select().from(groupMembers)).toHaveLength(2);
  });

  it('follows a supergroup migration and a private write-access grant', async () => {
    const basic = { id: -12345, type: 'group' as const, title: 'Old' };
    await insertGroup(db, { telegramChatId: basic.id, type: 'group' });
    await post(serviceUpdate(basic, alice, { migrate_to_chat_id: -1009999 }));
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(-1009999);
    await post(
      serviceUpdate(privateChat(bob), bob, { write_access_allowed: { from_request: true } }),
    );
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, bob.id));
    expect(user?.dmAllowed).toBe(true);
  });
});
