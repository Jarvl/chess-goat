import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dmMessages,
  games,
  jobs,
  matchNotes,
  ownerTokens,
  runnerLinkCodes,
  runners,
  turnLeases,
  users,
} from '../../src/db/schema';
import { recordDm } from '../../src/domain/dms';
import { deleteMyData } from '../../src/domain/account';
import { deleteBot } from '../../src/domain/bots';
import { createLinkCode } from '../../src/domain/runners';
import { createOwnerToken, resolveOwnerToken } from '../../src/domain/ownerTokens';
import { displayName } from '../../src/domain/users';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertRunner,
  insertTurnData,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('deleteMyData DMs', () => {
  it('retires every live DM of a deleted user', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', dmAllowed: true });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const first = await insertGame(db, group.id, alice.id, bob.id);
    const second = await insertGame(db, group.id, bob.id, alice.id);
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    const live = {
      userId: alice.id,
      chatId: 11,
      kind: 'turn' as const,
      stub: 'x',
      sentAt: new Date(),
    };
    await db.insert(dmMessages).values([
      { ...live, gameId: first.id, telegramMessageId: 101 },
      { ...live, gameId: second.id, telegramMessageId: 102 },
      { ...live, kind: 'challenge', challengeId: challenge.id, telegramMessageId: 103 },
    ]);

    await deleteMyData(deps, alice.id);

    expect(await db.select().from(dmMessages)).toEqual([]);
    const all = await db.select().from(jobs).orderBy(jobs.id);
    const retires = all.filter((job) => job.kind === 'retire_dm');
    expect(
      retires.map((job) => [job.payload.chatId, job.payload.telegramMessageId, job.payload.text]),
    ).toEqual([
      [11, 101, 'Game ended'],
      [11, 102, 'Game ended'],
      [11, 103, 'Game ended'],
    ]);
    const results = all.filter(
      (job) => job.kind === 'send_dm' && job.payload.template === 'result',
    );
    expect(results.map((job) => job.payload.userId)).toEqual([bob.id, bob.id]);
  });

  it("names the deleted player anonymously in the opponent's stubs", async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, {
      telegramUserId: 11,
      firstName: 'Alice',
      username: 'alice',
      flairWorn: ['rank_under_1200'],
    });
    const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id);
    const live = { userId: bob.id, chatId: 22, stub: 'x', sentAt: new Date() };
    await db.insert(dmMessages).values([
      { ...live, kind: 'turn', gameId: game.id, telegramMessageId: 201 },
      { ...live, kind: 'challenge', challengeId: challenge.id, telegramMessageId: 202 },
    ]);

    await deleteMyData(deps, alice.id);

    const retires = (await db.select().from(jobs).orderBy(jobs.id)).filter(
      (job) => job.kind === 'retire_dm',
    );
    expect(retires.map((job) => [job.payload.telegramMessageId, job.payload.text])).toEqual([
      [201, 'Game vs Deleted player ended'],
      [202, 'Challenge from Deleted player cancelled'],
    ]);
  });

  it('does not deadlock with a DM being recorded for the same game', async () => {
    // send_dm's record step locks the game row, then writes the user's dm_messages row;
    // deleteMyData must take the game lock before touching that user's DM rows.
    const group = await insertGroup(db);
    const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await recordDm(db, {
      userId: alice.id,
      chatId: 11,
      gameId: game.id,
      telegramMessageId: 101,
      kind: 'turn',
      stub: 'x',
    });
    let deleting: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, game.id)).for('update');
      deleting = deleteMyData(deps, alice.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await recordDm(tx, {
        userId: alice.id,
        chatId: 11,
        gameId: game.id,
        telegramMessageId: 102,
        kind: 'turn',
        stub: 'x',
      });
    });
    await expect(deleting).resolves.toBeUndefined();
    expect(await db.select().from(dmMessages)).toEqual([]);
  });
});

describe('deleteMyData bots', () => {
  it('deleting an owner deletes their bots and revokes their token', async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db, { telegramUserId: 11 });
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    const game = await insertGame(db, group.id, bot.id, human.id);
    const token = await createOwnerToken(db, owner.id);
    const published: string[] = [];
    deps.bus.subscribe(game.publicId, () => published.push(game.publicId));

    await deleteMyData(deps, owner.id);

    const [ended] = await db.select().from(games).where(eq(games.id, game.id));
    expect(ended).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(displayName(row!)).toBe('🤖 Deleted bot');
    expect(row!.deletedAt).not.toBeNull();
    expect(await resolveOwnerToken(db, token)).toBeNull();
    expect(await db.select().from(ownerTokens)).toEqual([]);
    expect(published).toEqual([game.publicId]);
  });

  it("erases every bot's persona, notes and turn rows, and the owner's runners and link codes", async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db, { telegramUserId: 11 });
    const other = await insertUser(db, { telegramUserId: 12 });
    const human = await insertUser(db);
    const bots = [await insertBot(db, owner), await insertBot(db, owner)];
    const theirs = await insertBot(db, other);
    const runner = await insertRunner(db, owner.id);
    const theirRunner = await insertRunner(db, other.id);
    for (const bot of bots) {
      await insertTurnData(db, bot, {
        groupId: group.id,
        opponentId: human.id,
        runnerId: runner.id,
      });
    }
    await insertTurnData(db, theirs, {
      groupId: group.id,
      opponentId: human.id,
      runnerId: theirRunner.id,
    });
    await createLinkCode(db, owner.id, {}, new Date());
    await createLinkCode(db, other.id, {}, new Date());

    await deleteMyData(deps, owner.id);

    for (const bot of bots) {
      const [row] = await db.select().from(users).where(eq(users.id, bot.id));
      expect(row).toMatchObject({ persona: null, botNotes: '', botNotesRevision: 4 });
    }
    expect((await db.select().from(matchNotes)).map((n) => n.botId)).toEqual([
      theirs.id,
      theirs.id,
    ]);
    expect((await db.select().from(turnLeases)).map((l) => [l.botId, l.runnerId])).toEqual([
      [theirs.id, theirRunner.id],
      [theirs.id, null],
      [theirs.id, null],
    ]);
    expect((await db.select().from(runners)).map((r) => r.id)).toEqual([theirRunner.id]);
    expect((await db.select().from(runnerLinkCodes)).map((c) => c.ownerId)).toEqual([other.id]);
    const [kept] = await db.select().from(users).where(eq(users.id, theirs.id));
    expect(kept).toMatchObject({ persona: 'Plays sharp.', botNotesRevision: 3 });
  });

  it('finishes a game between the owner and their own bot once', async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db, { telegramUserId: 11 });
    const bot = await insertBot(db, owner);
    const game = await insertGame(db, group.id, owner.id, bot.id);
    const published: string[] = [];
    deps.bus.subscribe(game.publicId, () => published.push(game.publicId));

    await deleteMyData(deps, owner.id);

    const [ended] = await db.select().from(games).where(eq(games.id, game.id));
    expect(ended).toMatchObject({ status: 'finished', endReason: 'resignation' });
    expect(published).toEqual([game.publicId]);
  });

  it('races deleteBot for the same bot without deadlocking', async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db, { telegramUserId: 11 });
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    await insertGame(db, group.id, owner.id, human.id);
    const game = await insertGame(db, group.id, bot.id, human.id);
    await insertChallenge(db, group.id, human.id, bot.id);

    const [mine, its] = await Promise.allSettled([
      deleteMyData(deps, owner.id),
      deleteBot(deps, owner.id, bot.id),
    ]);

    expect(mine.status).toBe('fulfilled');
    if (its.status === 'rejected') {
      expect((its.reason as { details?: { reason?: string } }).details?.reason).toBe(
        'bot_not_found',
      );
    }
    const [ended] = await db.select().from(games).where(eq(games.id, game.id));
    expect(ended).toMatchObject({ status: 'finished', result: '0-1' });
  });
});
