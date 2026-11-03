import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueSessionToken } from '../../src/api/session';
import { ownerTokens, users } from '../../src/db/schema';
import {
  createOwnerToken,
  ownerTokenStatus,
  resolveOwnerToken,
  revokeOwnerToken,
} from '../../src/domain/ownerTokens';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('owner tokens', () => {
  it('creates a prefixed token that resolves to its owner', async () => {
    const owner = await insertUser(db);
    const token = await createOwnerToken(db, owner.id);
    expect(token).toMatch(/^cgbot_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(ownerTokens).where(eq(ownerTokens.userId, owner.id));
    expect(Buffer.from(row!.tokenHash).length).toBe(32);
    expect(Buffer.from(row!.tokenHash).equals(Buffer.from(token))).toBe(false);
    expect((await resolveOwnerToken(db, token))?.id).toBe(owner.id);
  });

  it('rotating replaces the old token', async () => {
    const owner = await insertUser(db);
    const first = await createOwnerToken(db, owner.id);
    const second = await createOwnerToken(db, owner.id);
    expect(second).not.toBe(first);
    expect(await resolveOwnerToken(db, first)).toBeNull();
    expect((await resolveOwnerToken(db, second))?.id).toBe(owner.id);
  });

  it('revoking stops resolution, and revoking twice is fine', async () => {
    const owner = await insertUser(db);
    const token = await createOwnerToken(db, owner.id);
    await revokeOwnerToken(db, owner.id);
    await revokeOwnerToken(db, owner.id);
    expect(await resolveOwnerToken(db, token)).toBeNull();
    expect(await ownerTokenStatus(db, owner.id)).toBeNull();
  });

  it('resolves a token with surrounding whitespace or a trailing newline', async () => {
    const owner = await insertUser(db);
    const token = await createOwnerToken(db, owner.id);
    expect((await resolveOwnerToken(db, `  ${token}\n`))?.id).toBe(owner.id);
    expect((await resolveOwnerToken(db, `${token}\r\n`))?.id).toBe(owner.id);
  });

  it('rejects junk without throwing', async () => {
    const owner = await insertUser(db);
    await createOwnerToken(db, owner.id);
    const jwt = await issueSessionToken('test-secret', owner.id);
    for (const junk of ['', 'cgbot_', 'cgbot_short', jwt, 'a'.repeat(10_000)]) {
      expect(await resolveOwnerToken(db, junk)).toBeNull();
    }
    expect(await resolveOwnerToken(db, `cgbot_${'A'.repeat(43)}`)).toBeNull();
  });

  it('stops resolving once the owner is deleted', async () => {
    const owner = await insertUser(db);
    const token = await createOwnerToken(db, owner.id);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, owner.id));
    expect(await resolveOwnerToken(db, token)).toBeNull();
  });

  it('refuses tokens for bots, the engine, deleted users and users without a Telegram id', async () => {
    const owner = await insertUser(db);
    const bot = await insertBot(db, owner);
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const gone = await insertUser(db, { deletedAt: new Date() });
    const anon = await insertUser(db, { telegramUserId: null });
    for (const id of [bot.id, engine!.id, gone.id, anon.id]) {
      await expect(createOwnerToken(db, id)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'not_a_human_owner' },
      });
    }
    await expect(createOwnerToken(db, 999_999_999)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ownerTokenStatus reports createdAt, and lastUsedAt after a resolve', async () => {
    const owner = await insertUser(db);
    expect(await ownerTokenStatus(db, owner.id)).toBeNull();
    const token = await createOwnerToken(db, owner.id);
    const before = await ownerTokenStatus(db, owner.id);
    expect(before?.createdAt).toBeInstanceOf(Date);
    expect(before?.lastUsedAt).toBeNull();
    await resolveOwnerToken(db, token);
    const after = await ownerTokenStatus(db, owner.id);
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
    const first = after!.lastUsedAt!.getTime();
    await resolveOwnerToken(db, token);
    expect((await ownerTokenStatus(db, owner.id))!.lastUsedAt!.getTime()).toBe(first);
  });
});
