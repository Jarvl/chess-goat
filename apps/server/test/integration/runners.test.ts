import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runnerLinkCodes, runners, turnLeases, users } from '../../src/db/schema';
import { isDomainError } from '../../src/domain/errors';
import {
  createLinkCode,
  listRunners,
  onlineBotIds,
  redeemLinkCode,
  resolveRunner,
  revokeRunner,
} from '../../src/domain/runners';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const T0 = new Date('2026-11-10T12:00:00Z');
const after = (s: number) => new Date(T0.getTime() + s * 1000);

const redeem = (code: string, input: { label?: string; harness?: string } = {}, now = T0) =>
  db.transaction((tx) => redeemLinkCode(tx, code, input, now));

const reasonOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (e) {
    if (isDomainError(e)) return e.details.reason;
    throw e;
  }
  return 'no error';
};

/** A runner for `ownerId`, linked at T0. */
async function link(ownerId: number, input: { label?: string; botIds?: number[] } = {}) {
  const { code } = await createLinkCode(db, ownerId, input, T0);
  return redeem(code);
}

describe('link codes', () => {
  it('round trips code to credential to runner', async () => {
    const owner = await insertUser(db);
    const { code, expiresAt } = await createLinkCode(
      db,
      owner.id,
      { label: ' Laptop ', preset: 'claude' },
      T0,
    );
    expect(code).toMatch(
      /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/,
    );
    expect(expiresAt).toEqual(after(600));
    const { runner, credential, preset } = await redeem(code, { harness: 'claude-code' });
    expect(credential).toMatch(/^cgrun_[A-Za-z0-9_-]{43}$/);
    expect(preset).toBe('claude');
    expect(runner).toMatchObject({
      ownerId: owner.id,
      label: 'Laptop',
      harness: 'claude-code',
      botIds: null,
    });
    expect(Buffer.from(runner.credentialHash).length).toBe(32);
    const resolved = await resolveRunner(db, credential, T0);
    expect(resolved?.runner.id).toBe(runner.id);
    expect(resolved?.owner.id).toBe(owner.id);
  });

  it('redeem input wins over the code label, and the default is Runner', async () => {
    const owner = await insertUser(db);
    const a = await createLinkCode(db, owner.id, { label: 'From code' }, T0);
    expect((await redeem(a.code, { label: 'Typed' })).runner.label).toBe('Typed');
    const b = await createLinkCode(db, owner.id, {}, T0);
    expect((await redeem(b.code)).runner.label).toBe('Runner');
  });

  it('works once', async () => {
    const owner = await insertUser(db);
    const { code } = await createLinkCode(db, owner.id, {}, T0);
    await redeem(code);
    expect(await reasonOf(redeem(code))).toBe('link_code_invalid');
  });

  it('accepts lower case and a missing dash', async () => {
    const owner = await insertUser(db);
    const a = await createLinkCode(db, owner.id, {}, T0);
    await redeem(a.code.toLowerCase());
    const b = await createLinkCode(db, owner.id, {}, T0);
    await redeem(b.code.replace('-', ' '));
  });

  it('refuses wrong, malformed and expired codes with one reason, and deletes an expired one', async () => {
    const owner = await insertUser(db);
    expect(await reasonOf(redeem('AAAA-AAAA'))).toBe('link_code_invalid');
    expect(await reasonOf(redeem('nope'))).toBe('link_code_invalid');
    const { code } = await createLinkCode(db, owner.id, {}, T0);
    // Outside a transaction, so the deletion is not rolled back with the refusal.
    expect(await reasonOf(redeemLinkCode(db, code, {}, after(601)))).toBe('link_code_invalid');
    expect(await db.select().from(runnerLinkCodes)).toHaveLength(0);
    expect(await db.select().from(runners)).toHaveLength(0);
  });

  it('refuses a sixth unused code but first drops expired ones', async () => {
    const owner = await insertUser(db);
    for (let i = 0; i < 5; i += 1) await createLinkCode(db, owner.id, {}, T0);
    expect(await reasonOf(createLinkCode(db, owner.id, {}, after(1)))).toBe('too_many_link_codes');
    await createLinkCode(db, owner.id, {}, after(601));
    expect(await db.select().from(runnerLinkCodes)).toHaveLength(1);
  });

  it('refuses a sixth runner', async () => {
    const owner = await insertUser(db);
    for (let i = 0; i < 5; i += 1) await link(owner.id);
    const { code } = await createLinkCode(db, owner.id, {}, T0);
    expect(await reasonOf(redeem(code))).toBe('too_many_runners');
  });

  it('two concurrent redemptions of one code yield one runner', async () => {
    const owner = await insertUser(db);
    const { code } = await createLinkCode(db, owner.id, {}, T0);
    const results = await Promise.allSettled([redeem(code), redeem(code)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(runners)).toHaveLength(1);
  });

  it('a code scoped to bots produces a runner with those botIds', async () => {
    const owner = await insertUser(db);
    const bot = await insertBot(db, owner);
    const { code } = await createLinkCode(db, owner.id, { botIds: [bot.id, bot.id] }, T0);
    expect((await redeem(code)).runner.botIds).toEqual([bot.id]);
  });

  it('refuses botIds that are not the owner’s live bots; an empty list means all', async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const theirs = await insertBot(db, other);
    expect(await reasonOf(createLinkCode(db, owner.id, { botIds: [theirs.id] }, T0))).toBe(
      'bot_not_found',
    );
    const { code } = await createLinkCode(db, owner.id, { botIds: [] }, T0);
    expect((await redeem(code)).runner.botIds).toBeNull();
  });
});

describe('resolveRunner', () => {
  it('refuses wrong, mis-shaped and foreign-prefixed credentials', async () => {
    const owner = await insertUser(db);
    const { credential } = await link(owner.id);
    expect(await resolveRunner(db, `cgrun_${'a'.repeat(43)}`, T0)).toBeNull();
    expect(await resolveRunner(db, 'cgrun_short', T0)).toBeNull();
    expect(await resolveRunner(db, credential.replace('cgrun_', 'cgbot_'), T0)).toBeNull();
  });

  it('touches lastSeenAt at most once a minute', async () => {
    const owner = await insertUser(db);
    const { runner, credential } = await link(owner.id);
    const seen = async () =>
      (await db.select().from(runners).where(eq(runners.id, runner.id)))[0]!.lastSeenAt;
    expect(await seen()).toBeNull();
    await resolveRunner(db, credential, T0);
    expect(await seen()).toEqual(T0);
    await resolveRunner(db, credential, after(30));
    expect(await seen()).toEqual(T0);
    await resolveRunner(db, credential, after(61));
    expect(await seen()).toEqual(after(61));
  });

  it('resolves to null once the owner is deleted', async () => {
    const owner = await insertUser(db);
    const { credential } = await link(owner.id);
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, owner.id));
    expect(await resolveRunner(db, credential, T0)).toBeNull();
  });
});

describe('listing and revoking', () => {
  it('lists runners with bot names and connectedness', async () => {
    const owner = await insertUser(db);
    const zed = await insertBot(db, owner, { firstName: 'Zed' });
    const amy = await insertBot(db, owner, { firstName: 'Amy' });
    const gone = await insertBot(db, owner, { firstName: 'Gone' });
    const all = await link(owner.id, { label: 'All' });
    const some = await link(owner.id, { label: 'Some', botIds: [zed.id, amy.id, gone.id] });
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, gone.id));
    await resolveRunner(db, some.credential, after(100));
    const views = await listRunners(db, owner.id, after(150));
    expect(views.map((v) => v.id)).toEqual([all.runner.id, some.runner.id]);
    expect(views[0]).toMatchObject({ bots: 'all', connected: false, lastSeenAt: null });
    expect(views[1]).toMatchObject({ bots: ['Amy', 'Zed'], connected: true });
    expect((await listRunners(db, owner.id, after(191)))[1]!.connected).toBe(false);
  });

  it('revoking stops the credential and nulls a lease it held', async () => {
    const owner = await insertUser(db);
    const bot = await insertBot(db, owner);
    const { runner, credential } = await link(owner.id);
    const [lease] = await db
      .insert(turnLeases)
      .values({ botId: bot.id, kind: 'move', runnerId: runner.id, leasedUntil: after(300) })
      .returning();
    await revokeRunner(db, owner.id, runner.id);
    expect(await resolveRunner(db, credential, T0)).toBeNull();
    const [after_] = await db.select().from(turnLeases).where(eq(turnLeases.id, lease!.id));
    expect(after_!.runnerId).toBeNull();
  });

  it('another owner’s or a missing runner id is runner_not_found', async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const { runner } = await link(owner.id);
    expect(await reasonOf(revokeRunner(db, other.id, runner.id))).toBe('runner_not_found');
    expect(await reasonOf(revokeRunner(db, owner.id, runner.id + 999))).toBe('runner_not_found');
    expect(await db.select().from(runners)).toHaveLength(1);
  });
});

describe('onlineBotIds', () => {
  it('respects runner scope, owner and the 90 second window', async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const a = await insertBot(db, owner);
    const b = await insertBot(db, owner);
    const c = await insertBot(db, other);
    const scoped = await link(owner.id, { botIds: [a.id] });
    await resolveRunner(db, scoped.credential, T0);
    const ids = [a.id, b.id, c.id];
    expect(await onlineBotIds(db, ids, after(89))).toEqual(new Set([a.id]));
    expect(await onlineBotIds(db, ids, after(91))).toEqual(new Set());
    const wide = await link(owner.id);
    await resolveRunner(db, wide.credential, after(60));
    expect(await onlineBotIds(db, ids, after(100))).toEqual(new Set([a.id, b.id]));
    expect(await onlineBotIds(db, [], T0)).toEqual(new Set());
  });
});
