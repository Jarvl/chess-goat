import { Hono } from 'hono';
import pino from 'pino';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { webhookRoutes } from '../../src/bot/webhook';
import type { Deps } from '../../src/domain/deps';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { commandUpdate, supergroup, tgUser } from '../helpers/updates';

// Diagnostics for prompts that end up public, and for updates Telegram delivers late: the two
// ways a /challenge prompt can appear in a group without anyone having just asked for it.

const { db, close } = openTestDb();
let lines: Record<string, unknown>[] = [];
const deps: Deps = {
  ...testDeps(db),
  log: pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) }),
};
let fake: FakeTelegram;
let app: Hono;
const config = testConfig();
const chat = supergroup(-1001000000001);
const alice = tgUser(11, 'Alice', 'alice');

beforeAll(async () => {
  fake = await FakeTelegram.start();
});
beforeEach(async () => {
  await truncateAll(db);
  const bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config));
  fake.reset();
  lines = [];
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: Update) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': config.WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });

/** A /challenge sent `ageSeconds` ago. */
const challengeSent = (ageSeconds: number, ephemeral: boolean): Update => {
  const update = commandUpdate({ chat, from: alice, text: '/challenge', ephemeral });
  return {
    ...update,
    message: { ...update.message!, date: Math.floor(Date.now() / 1000) - ageSeconds },
  };
};
const logged = (msg: string) => lines.filter((line) => line.msg === msg);

describe('bot diagnostics', () => {
  it('logs why a challenge prompt went public: the command was not a private one', async () => {
    await post(challengeSent(0, false));
    expect(logged('challenge prompt posted publicly')).toEqual([
      expect.objectContaining({ level: 30, reason: 'not_private_command', chatId: chat.id }),
    ]);
  });

  it('logs why a challenge prompt went public: Telegram refused the private answer', async () => {
    // Refused with the bot button, and again without it.
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    await post(challengeSent(0, true));
    const refusal = expect.objectContaining({
      level: 40,
      code: 400,
      description: 'Bad Request: not supported',
    });
    expect(logged('ephemeral send refused')).toEqual([refusal, refusal]);
    expect(logged('challenge prompt posted publicly')).toEqual([
      expect.objectContaining({ reason: 'private_send_refused', chatId: chat.id }),
    ]);
    expect(logged('challenge prompt sent without bot button')).toEqual([]);
  });

  it('logs a private prompt sent without its bot button', async () => {
    fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request: not supported' });
    await post(challengeSent(0, true));
    expect(logged('challenge prompt sent without bot button')).toEqual([
      expect.objectContaining({ level: 30, chatId: chat.id }),
    ]);
    expect(logged('challenge prompt posted publicly')).toEqual([]);
  });

  it('logs nothing when the prompt is private', async () => {
    await post(challengeSent(0, true));
    expect(logged('challenge prompt posted publicly')).toEqual([]);
    expect(logged('ephemeral send refused')).toEqual([]);
  });

  it('logs an update that arrives more than a minute after it was sent', async () => {
    const late = challengeSent(3600, true);
    await post(late);
    expect(logged('late update')).toEqual([
      expect.objectContaining({ level: 40, updateId: late.update_id, type: 'message' }),
    ]);
    expect(logged('late update')[0]!.ageSeconds).toBeGreaterThanOrEqual(3600);
  });

  it('does not log an update that arrives on time', async () => {
    await post(challengeSent(5, true));
    expect(logged('late update')).toEqual([]);
  });
});
