import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema';
import { ensureUser } from '../../src/domain/users';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const ownerNameOf = async (id: number) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]!.ownerName;

describe('bot owner labels', () => {
  it('refreshes owner labels when the owner is seen', async () => {
    const owner = await insertUser(db, { telegramUserId: 77, username: 'jo' });
    const bot = await insertBot(db, owner);
    expect(bot.ownerName).toBe('@jo');

    await ensureUser(db, { telegramUserId: 77, firstName: 'Jo', username: 'joanna' });
    expect(await ownerNameOf(bot.id)).toBe('@joanna');

    await ensureUser(db, { telegramUserId: 77, firstName: 'Jo', username: 'joanna' });
    expect(await ownerNameOf(bot.id)).toBe('@joanna');
  });

  it('does not relabel deleted bots', async () => {
    const owner = await insertUser(db, { telegramUserId: 77, username: 'jo' });
    const bot = await insertBot(db, owner, { deletedAt: new Date() });

    await ensureUser(db, { telegramUserId: 77, firstName: 'Jo', username: 'joanna' });
    expect(await ownerNameOf(bot.id)).toBe('@jo');
  });
});
