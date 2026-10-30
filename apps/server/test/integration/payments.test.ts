import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { webhookRoutes } from '../../src/bot/webhook';
import { jobs, tips, users } from '../../src/db/schema';
import { deleteMyData } from '../../src/domain/account';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import {
  commandUpdate,
  preCheckoutUpdate,
  privateChat,
  serviceUpdate,
  supergroup,
  tgUser,
} from '../helpers/updates';

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let fake: FakeTelegram;
let bot: Bot;
let app: Hono;

// Alice is never inserted up front: her first contact with the bot is the payment itself.
const alice = tgUser(11, 'Alice', 'alice');

beforeAll(async () => {
  fake = await FakeTelegram.start();
  bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config, new Metrics()));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: unknown) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': config.WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
const dms = async () =>
  (await db.select().from(jobs).orderBy(jobs.id))
    .filter((job) => job.kind === 'send_message')
    .map((job) => job.payload);
const paid = (chargeId: string, stars = 250) =>
  serviceUpdate(privateChat(alice), alice, {
    successful_payment: {
      currency: 'XTR',
      total_amount: stars,
      invoice_payload: `tip:v1:${stars}`,
      telegram_payment_charge_id: chargeId,
      provider_payment_charge_id: '',
    },
  });
const refunded = (chargeId: string, stars = 250) =>
  serviceUpdate(privateChat(alice), alice, {
    refunded_payment: {
      currency: 'XTR',
      total_amount: stars,
      invoice_payload: `tip:v1:${stars}`,
      telegram_payment_charge_id: chargeId,
    },
  });

describe('pre_checkout_query', () => {
  it('approves a matching Stars tip', async () => {
    expect(
      (await post(preCheckoutUpdate({ from: alice, payload: 'tip:v1:250', totalAmount: 250 })))
        .status,
    ).toBe(200);
    const [call] = fake.callsTo('answerPreCheckoutQuery');
    expect(call?.body).toMatchObject({ ok: true });
    expect(call?.body.pre_checkout_query_id).toMatch(/^pcq-/);
  });

  // Which checkouts are refused is tipCheckoutAccepted's, tested in unit/tips; this is the wiring.
  it('refuses a checkout that does not match its tip with a short reason', async () => {
    await post(preCheckoutUpdate({ from: alice, payload: 'tip:v1:250', totalAmount: 100 }));
    expect(fake.callsTo('answerPreCheckoutQuery')[0]?.body).toMatchObject({
      ok: false,
      error_message: 'This tip link is no longer valid.',
    });
  });

  it('answers 500 so Telegram retries when the answer cannot be sent', async () => {
    fake.failNext('answerPreCheckoutQuery', {
      error_code: 400,
      description: 'Bad Request: query is too old',
    });
    const res = await post(
      preCheckoutUpdate({ from: alice, payload: 'tip:v1:250', totalAmount: 250 }),
    );
    expect(res.status).toBe(500);
  });
});

describe('successful_payment', () => {
  it('records the tip and queues one thank-you DM for a first-time payer', async () => {
    expect((await post(paid('charge-1'))).status).toBe(200);
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, 11));
    expect(await db.select().from(tips)).toEqual([
      expect.objectContaining({
        userId: user!.id,
        telegramUserId: 11,
        stars: 250,
        telegramPaymentChargeId: 'charge-1',
        refundedAt: null,
      }),
    ]);
    expect(await dms()).toEqual([
      {
        chatId: 11,
        threadId: null,
        text: 'Thank you for the ★250 tip! It helps keep Chess Goat running.',
      },
    ]);
  });

  it('ignores a replay of the same update', async () => {
    const update = paid('charge-1');
    await post(update);
    await post(update);
    expect(await db.select().from(tips)).toHaveLength(1);
    expect(await dms()).toHaveLength(1);
  });

  it('adds no row and no DM when the same charge arrives in a new update', async () => {
    await post(paid('charge-1'));
    await post(paid('charge-1'));
    expect(await db.select().from(tips)).toHaveLength(1);
    expect(await dms()).toHaveLength(1);
  });
});

describe('refunded_payment', () => {
  it('marks the tip refunded', async () => {
    await post(paid('charge-1'));
    await post(refunded('charge-1'));
    const [row] = await db.select().from(tips);
    expect(row?.refundedAt).toBeInstanceOf(Date);
  });

  it('marks a tip refunded even after the payer deleted their data', async () => {
    await post(paid('charge-1'));
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, 11));
    await deleteMyData(deps, user!.id);
    await post(refunded('charge-1'));
    const [row] = await db.select().from(tips);
    expect(row).toMatchObject({ telegramUserId: 11 });
    expect(row?.refundedAt).toBeInstanceOf(Date);
  });

  it('does nothing for an unknown charge id', async () => {
    expect((await post(refunded('charge-unknown'))).status).toBe(200);
    expect(await db.select().from(tips)).toHaveLength(0);
  });
});

describe('/paysupport', () => {
  it('explains tips and refunds in a private chat', async () => {
    await post(commandUpdate({ chat: privateChat(alice), from: alice, text: '/paysupport' }));
    expect(await dms()).toEqual([
      {
        chatId: 11,
        threadId: null,
        text: 'Tips unlock nothing in Chess Goat; they only support its hosting and development. For a refund within 30 days of a tip, message @Jarvl.',
      },
    ]);
  });

  it('stays silent in a group', async () => {
    await post(
      commandUpdate({ chat: supergroup(-1001000000001), from: alice, text: '/paysupport' }),
    );
    expect(await dms()).toEqual([]);
  });
});
