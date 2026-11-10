import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramApi } from '../../src/telegram/client';
import {
  createTipInvoiceLink,
  parseTipPayload,
  tipCheckoutAccepted,
  tipPayload,
} from '../../src/telegram/tips';
import { FakeTelegram } from '../helpers/fakeTelegram';

describe('tip payload', () => {
  it('round-trips an amount', () => {
    expect(tipPayload(250)).toBe('tip:v1:250');
    expect(parseTipPayload(tipPayload(250))).toBe(250);
  });

  it.each(['tip:v1:1', 'tip:v1:10000'])('accepts %s', (payload) => {
    expect(parseTipPayload(payload)).not.toBeNull();
  });

  it.each([
    ['zero', 'tip:v1:0'],
    ['a leading zero', 'tip:v1:0100'],
    ['over the maximum', 'tip:v1:10001'],
    ['another version', 'tip:v2:100'],
    ['another prefix', 'donation:v1:100'],
    ['trailing text', 'tip:v1:100 '],
    ['a fraction', 'tip:v1:2.5'],
    ['nothing', ''],
  ])('rejects %s', (_label, payload) => {
    expect(parseTipPayload(payload)).toBeNull();
  });
});

describe('tipCheckoutAccepted', () => {
  const query = { invoice_payload: 'tip:v1:250', total_amount: 250, currency: 'XTR' };

  it('approves a matching Stars tip', () => {
    expect(tipCheckoutAccepted(query)).toBe(true);
  });

  it.each([
    ['an amount that differs from the payload', { ...query, total_amount: 100 }],
    ['another currency', { ...query, currency: 'USD' }],
    ['a forged payload', { ...query, invoice_payload: 'tip:v1:0250' }],
  ])('refuses %s', (_label, bad) => {
    expect(tipCheckoutAccepted(bad)).toBe(false);
  });
});

describe('createTipInvoiceLink', () => {
  let fake: FakeTelegram | null = null;

  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  // A hung createInvoiceLink must still fail fast, so the card can answer 500 instead
  // of spinning for however long grammY's default timeout (minutes) would otherwise allow.
  it('rejects once the timeout elapses, instead of hanging', async () => {
    fake = await FakeTelegram.start();
    const api = createTelegramApi({ BOT_TOKEN: '123456:TEST-TOKEN' }, { apiRoot: fake.url });
    fake.holdNext('createInvoiceLink');
    await expect(createTipInvoiceLink(api, 100, 30)).rejects.toThrow();
    expect(fake.callsTo('createInvoiceLink')).toHaveLength(1);
  });
});
