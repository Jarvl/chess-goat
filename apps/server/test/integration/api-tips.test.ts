import { TipInvoiceDtoSchema } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tips } from '../../src/db/schema';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.rateLimiter.reset();
  api.ctx.tipLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

const tipAs = async (stars: unknown, user?: { id: number }) => {
  const payer = user ?? (await insertUser(db));
  return api.request('POST', '/api/tips', {
    token: await api.sessionFor(payer),
    body: { stars },
  });
};

describe('POST /api/tips', () => {
  it('mints a Stars invoice link for the amount and returns its URL', async () => {
    const res = await tipAs(250);
    expect(res.status).toBe(200);
    expect(TipInvoiceDtoSchema.parse(await res.json())).toEqual({
      url: 'https://t.me/$TestInvoice',
    });
    const calls = api.fake.callsTo('createInvoiceLink');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      title: 'Tip Chess Goat',
      description: 'A one-off tip to @Jarvl for hosting and development. Nothing is unlocked.',
      payload: 'tip:v1:250',
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Tip', amount: 250 }],
    });
  });

  it.each([0, 10_001, 2.5, '100', -5])(
    'rejects %s stars without calling Telegram',
    async (stars) => {
      const res = await tipAs(stars);
      expect(res.status).toBe(400);
      expect(api.fake.callsTo('createInvoiceLink')).toHaveLength(0);
    },
  );

  it('needs a session', async () => {
    const res = await api.request('POST', '/api/tips', { body: { stars: 100 } });
    expect(res.status).toBe(401);
  });

  it('allows ten invoices a minute per user, then answers 429', async () => {
    const payer = await insertUser(db);
    for (let i = 0; i < 10; i += 1) expect((await tipAs(100, payer)).status).toBe(200);
    const eleventh = await tipAs(100, payer);
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect((await tipAs(100)).status).toBe(200);
  });

  it('answers 500 when Telegram refuses the invoice', async () => {
    api.fake.failNext('createInvoiceLink', {
      error_code: 400,
      description: 'Bad Request: STARS_INVOICE_INVALID',
    });
    const res = await tipAs(100);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal' } });
  });
});

describe('DELETE /api/me', () => {
  it('keeps tip rows when the payer deletes their data', async () => {
    const payer = await insertUser(db, { telegramUserId: 11 });
    await db.insert(tips).values({
      userId: payer.id,
      telegramUserId: 11,
      stars: 500,
      telegramPaymentChargeId: 'charge-kept',
    });
    const token = await api.sessionFor(payer);
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    const [row] = await db
      .select()
      .from(tips)
      .where(eq(tips.telegramPaymentChargeId, 'charge-kept'));
    expect(row).toMatchObject({
      userId: payer.id,
      telegramUserId: 11,
      stars: 500,
      refundedAt: null,
    });
  });
});
