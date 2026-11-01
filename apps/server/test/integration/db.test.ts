import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dbNow } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { dmMessages, userFlair, users } from '../../src/db/schema';
import { listMoves, requireGameById } from '../../src/domain/games';
import { storePhoto } from '../../src/domain/photos';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';
import { testDatabaseUrl } from '../helpers/testDatabase';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('database', () => {
  it('truncates while a photo write holds its user row, without deadlocking', async () => {
    // The fetch job locks `users` then writes `user_photos`; truncateAll must take them in that order.
    const user = await insertUser(db);
    let truncating: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, user.id)).for('update');
      truncating = truncateAll(db);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await storePhoto(tx, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    });
    await expect(truncating).resolves.toBeUndefined();
  });

  it("truncates while a flair award holds its players' rows, without deadlocking", async () => {
    // The award job reads the game and its moves, locks both players' `users`
    // rows, then writes `user_flair`; truncateAll must take those tables in that order.
    const group = await insertGroup(db);
    const white = await insertUser(db);
    const black = await insertUser(db);
    const game = await insertGame(db, group.id, white.id, black.id);
    let truncating: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await requireGameById(tx, game.id);
      await listMoves(tx, game.id);
      await tx
        .select()
        .from(users)
        .where(inArray(users.id, [white.id, black.id]))
        .orderBy(users.id)
        .for('no key update');
      truncating = truncateAll(db);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx
        .insert(userFlair)
        .values({ userId: white.id, flairId: 'draws_10', gameId: game.id, earnedAt: new Date() });
    });
    await expect(truncating).resolves.toBeUndefined();
  });

  it('has every table after migration and is idempotent to migrate again', async () => {
    await runMigrations(testDatabaseUrl());
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'admin_actions',
      'board_images',
      'challenge_prompts',
      'challenges',
      'dm_messages',
      'flair_backfills',
      // Unused; kept until a later release so the previous image can still boot (backfill spec §2).
      'flair_introductions',
      'games',
      'group_members',
      'groups',
      'jobs',
      'moves',
      'ratings',
      'shares',
      'telegram_updates',
      'tips',
      'user_flair',
      'user_photos',
      'users',
    ]);
  });

  it('reads the database clock as a Date close to the wall clock', async () => {
    const now = await dbNow(db);
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe('dm_messages table', () => {
  async function gameAndChallenge() {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    return { alice, game, challenge };
  }
  const live = { chatId: 11, kind: 'turn' as const, stub: 'Game vs Bob ended', sentAt: new Date() };

  it('allows one live DM per user and game', async () => {
    const { alice, game } = await gameAndChallenge();
    await db
      .insert(dmMessages)
      .values({ ...live, userId: alice.id, gameId: game.id, telegramMessageId: 101 });
    await expect(
      db
        .insert(dmMessages)
        .values({ ...live, userId: alice.id, gameId: game.id, telegramMessageId: 102 }),
    ).rejects.toThrow();
  });

  it('requires exactly one of game and challenge on a DM row', async () => {
    const { alice, game, challenge } = await gameAndChallenge();
    await expect(
      db.insert(dmMessages).values({ ...live, userId: alice.id, telegramMessageId: 101 }),
    ).rejects.toThrow();
    await expect(
      db.insert(dmMessages).values({
        ...live,
        userId: alice.id,
        gameId: game.id,
        challengeId: challenge.id,
        telegramMessageId: 102,
      }),
    ).rejects.toThrow();
  });
});
