import { Api } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteEphemeral, editEphemeral, sendEphemeral } from '../../src/bot/ephemeral';
import { FakeTelegram } from '../helpers/fakeTelegram';

let fake: FakeTelegram;
let api: Api;

beforeAll(async () => {
  fake = await FakeTelegram.start();
  api = new Api('123:TEST', { apiRoot: fake.url });
});
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const base = { chatId: -100, threadId: null, receiverId: 7, text: 'hello' };

describe('sendEphemeral', () => {
  it('answers a message trigger with reply_parameters', async () => {
    const result = await sendEphemeral(api, { ...base, trigger: { ephemeralMessageId: 55 } });
    expect(result).toEqual({ ephemeralMessageId: expect.any(Number) });
    const body = fake.callsTo('sendMessage')[0]!.body;
    expect(body).toMatchObject({
      chat_id: -100,
      text: 'hello',
      reply_parameters: { ephemeral_message_id: 55 },
      ephemeral_message_parameters: { receiver_user_id: 7 },
    });
    expect(body).not.toHaveProperty('message_thread_id');
  });

  it('answers a callback trigger with callback_query_id and no reply_parameters', async () => {
    await sendEphemeral(api, {
      ...base,
      threadId: 9,
      trigger: { callbackQueryId: 'cb1' },
      replyMarkup: { inline_keyboard: [], force_reply: true },
    });
    const body = fake.callsTo('sendMessage')[0]!.body;
    expect(body).toMatchObject({
      message_thread_id: 9,
      ephemeral_message_parameters: { receiver_user_id: 7, callback_query_id: 'cb1' },
      reply_markup: { force_reply: true },
    });
    expect(body).not.toHaveProperty('reply_parameters');
  });

  it('returns null on any 4xx', async () => {
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request' });
    expect(await sendEphemeral(api, { ...base, trigger: { ephemeralMessageId: 1 } })).toBeNull();
  });

  it('rethrows other failures', async () => {
    fake.failNext('sendMessage', { error_code: 500, description: 'Internal' });
    await expect(
      sendEphemeral(api, { ...base, trigger: { ephemeralMessageId: 1 } }),
    ).rejects.toThrow();
  });
});

describe('editEphemeral / deleteEphemeral', () => {
  it('posts the edit with text and markup', async () => {
    const replyMarkup = { inline_keyboard: [[{ text: 'Go', callback_data: 'x' }]] };
    await editEphemeral(api, {
      chatId: -100,
      receiverId: 7,
      ephemeralMessageId: 3,
      text: 'new',
      replyMarkup,
    });
    expect(fake.callsTo('editEphemeralMessageText')[0]!.body).toEqual({
      chat_id: -100,
      receiver_user_id: 7,
      ephemeral_message_id: 3,
      text: 'new',
      reply_markup: replyMarkup,
    });
  });

  it('posts the delete', async () => {
    await deleteEphemeral(api, { chatId: -100, receiverId: 7, ephemeralMessageId: 3 });
    expect(fake.callsTo('deleteEphemeralMessage')[0]!.body).toEqual({
      chat_id: -100,
      receiver_user_id: 7,
      ephemeral_message_id: 3,
    });
  });

  it('swallows not-found and rethrows other errors', async () => {
    fake.failNext('deleteEphemeralMessage', {
      error_code: 400,
      description: 'Bad Request: message to delete not found',
    });
    await deleteEphemeral(api, { chatId: -100, receiverId: 7, ephemeralMessageId: 3 });
    fake.failNext('editEphemeralMessageText', {
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    await editEphemeral(api, {
      chatId: -100,
      receiverId: 7,
      ephemeralMessageId: 3,
      text: 't',
      replyMarkup: { inline_keyboard: [] },
    });
    fake.failNext('deleteEphemeralMessage', { error_code: 403, description: 'Forbidden' });
    await expect(
      deleteEphemeral(api, { chatId: -100, receiverId: 7, ephemeralMessageId: 3 }),
    ).rejects.toThrow();
  });
});
