import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, groupMembers, jobs, ratings, users } from '../../src/db/schema';
import { getLeaderboard } from '../../src/domain/ratings';
import { listKnownPlayers } from '../../src/domain/members';
import { awardFlairForGame } from '../../src/flair/award';
import { runFlairBackfill } from '../../src/flair/backfill';
import { setWornFlair } from '../../src/flair/profile';
import { LINES } from '../helpers/chess';
import { earned, finishedGame } from '../helpers/flair';
import { createBot, deleteBot, listBots, normaliseBotName, updateBot } from '../../src/domain/bots';
import { displayName, ensureUser, wornFlair } from '../../src/domain/users';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

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

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (
      (e as { details?: { reason?: string } }).details?.reason ?? `raw:${(e as Error).message}`
    );
  }
  return 'resolved';
};

describe('bot management', () => {
  it("creates a bot with no Telegram id and its owner's label", async () => {
    const owner = await insertUser(db, { username: 'jo' });
    const bot = await createBot(db, owner.id, { name: 'Deep Goat' });
    expect(bot.ownerId).toBe(owner.id);
    expect(bot.ownerName).toBe('@jo');
    expect(bot.telegramUserId).toBeNull();
    expect(bot.isEngine).toBe(false);
    expect(displayName(bot)).toBe('🤖 Deep Goat (@jo)');
  });

  it('normalises names', async () => {
    const owner = await insertUser(db);
    expect(normaliseBotName('  Deep   Goat ')).toBe('Deep Goat');
    expect((await createBot(db, owner.id, { name: '  Deep   Goat ' })).firstName).toBe('Deep Goat');
  });

  it('refuses invalid names', async () => {
    const owner = await insertUser(db);
    for (const name of ['', '   ', 'a'.repeat(33), '@goat', '-goat', 'goat!', 'stockfish']) {
      expect(await reason(createBot(db, owner.id, { name }))).toBe('invalid_bot_name');
    }
  });

  it('refuses taken names case-insensitively', async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    await createBot(db, a.id, { name: 'Deep Goat' });
    expect(await reason(createBot(db, b.id, { name: 'deep  goat' }))).toBe('bot_name_taken');
  });

  it('refuses a taken name when two creates race', async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    const results = await Promise.all([
      reason(createBot(db, a.id, { name: 'Racer' })),
      reason(createBot(db, b.id, { name: 'Racer' })),
    ]);
    expect(results.sort()).toEqual(['bot_name_taken', 'resolved']);
  });

  it('refuses taglines over 80 characters or with line breaks', async () => {
    const owner = await insertUser(db);
    expect(await reason(createBot(db, owner.id, { name: 'A', tagline: 'x'.repeat(81) }))).toBe(
      'invalid_tagline',
    );
    expect(await reason(createBot(db, owner.id, { name: 'A', tagline: 'a\nb' }))).toBe(
      'invalid_tagline',
    );
    expect(
      (await createBot(db, owner.id, { name: 'A', tagline: 'x'.repeat(80) })).tagline,
    ).toHaveLength(80);
  });

  it('allows 20 bots and refuses the 21st', async () => {
    const owner = await insertUser(db);
    for (let i = 0; i < 20; i++) await createBot(db, owner.id, { name: `Bot ${i}` });
    try {
      await createBot(db, owner.id, { name: 'One too many' });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('limit_exceeded');
      expect((e as { details: unknown }).details).toMatchObject({
        reason: 'too_many_bots',
        limit: 20,
      });
    }
  });

  it('only humans own bots', async () => {
    const human = await insertUser(db);
    const owners = [
      await insertBot(db, human),
      (await db.select().from(users).where(eq(users.isEngine, true)))[0]!,
      await insertUser(db, { deletedAt: new Date() }),
      await insertUser(db, { telegramUserId: null }),
    ];
    for (const o of owners) {
      expect(await reason(createBot(db, o.id, { name: `X${o.id}` }))).toBe('not_a_human_owner');
    }
  });

  it('updates name and tagline, and only for the owner', async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    const bot = await createBot(db, a.id, { name: 'Deep Goat' });
    await createBot(db, b.id, { name: 'Taken' });
    expect(await reason(updateBot(db, b.id, bot.id, { name: 'Mine' }))).toBe('bot_not_found');
    expect(await reason(updateBot(db, a.id, bot.id, { name: 'taken' }))).toBe('bot_name_taken');
    const renamed = await updateBot(db, a.id, bot.id, { name: 'DEEP GOAT', tagline: 'baa' });
    expect(renamed.firstName).toBe('DEEP GOAT');
    expect(renamed.tagline).toBe('baa');
  });

  it('lists live bots oldest first', async () => {
    const owner = await insertUser(db);
    const first = await createBot(db, owner.id, { name: 'First' });
    await insertBot(db, owner, { deletedAt: new Date() });
    const second = await createBot(db, owner.id, { name: 'Second' });
    expect((await listBots(db, owner.id)).map((b) => b.id)).toEqual([first.id, second.id]);
  });
});

describe('bots are not people', () => {
  it('awards no flair for a game against a bot', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bot = await insertBot(db, alice);
    const game = await finishedGame(db, group.id, alice.id, bot.id, 2, '1-0', {
      line: LINES.scholarsMateQh5,
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(db, alice.id)).toEqual([]);
    expect(await earned(db, bot.id)).toEqual([]);
  });

  it('the backfill ignores games against bots', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bot = await insertBot(db, alice);
    for (let d = 2; d < 12; d += 1)
      await finishedGame(db, group.id, alice.id, bot.id, d, '1/2-1/2');
    const summary = await runFlairBackfill(db, [{ id: 'draws_10', version: 1 }]);
    expect(summary.players).toBe(0);
    expect(await earned(db, alice.id)).toEqual([]);
    expect(await earned(db, bot.id)).toEqual([]);
  });

  it('a bot cannot wear flair', async () => {
    const alice = await insertUser(db);
    const bot = await insertBot(db, alice, { flairWorn: ['draws_10'] });
    await expect(setWornFlair(db, bot.id, [])).rejects.toMatchObject({ code: 'forbidden' });
    expect(wornFlair(bot)).toEqual([]);
  });

  it('the leaderboard leaves bots out', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bot = await insertBot(db, alice);
    for (const u of [alice, bot]) {
      await db.insert(ratings).values({
        groupId: group.id,
        userId: u.id,
        rating: 1500,
        rd: 100,
        volatility: 0.06,
        gamesPlayed: 3,
      });
    }
    const board = await getLeaderboard(db, group.id);
    expect(board.map((e) => e.id)).toEqual([String(alice.id)]);
  });

  it('the opponent picker leaves bots out', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bot = await insertBot(db, alice);
    const bob = await insertUser(db);
    await db.insert(groupMembers).values([
      { groupId: group.id, userId: bot.id },
      { groupId: group.id, userId: bob.id },
    ]);
    const known = await listKnownPlayers(db, group.id);
    expect(known.map((p) => p.id)).toEqual([String(bob.id)]);
  });
});

describe('deletion', () => {
  const userRow = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0]!;

  it('deleteBot resigns live games and settles challenges', async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db);
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    const game = await insertGame(db, group.id, bot.id, human.id);
    const from = await insertChallenge(db, group.id, bot.id, human.id);
    const to = await insertChallenge(db, group.id, human.id, bot.id);
    const published: string[] = [];
    deps.bus.subscribe(game.publicId, () => published.push(game.publicId));

    await deleteBot(deps, owner.id, bot.id);

    const [ended] = await db.select().from(games).where(eq(games.id, game.id));
    expect(ended).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    const settled = await db.select().from(challenges).orderBy(challenges.id);
    expect(settled.map((c) => [c.id, c.status, c.resolvedAt !== null])).toEqual([
      [from.id, 'cancelled', true],
      [to.id, 'declined', true],
    ]);
    const cards = (await db.select().from(jobs).orderBy(jobs.id)).filter(
      (job) => job.kind === 'edit_card' && job.payload.challengeId !== undefined,
    );
    expect(cards.map((job) => [job.payload.challengeId, job.dedupKey])).toEqual([
      [from.id, `card:ch:${from.publicId}`],
      [to.id, `card:ch:${to.publicId}`],
    ]);
    expect(published).toEqual([game.publicId]);
  });

  it('a deleted bot is anonymised and frees its name', async () => {
    const group = await insertGroup(db);
    const owner = await insertUser(db);
    const bot = await createBot(db, owner.id, { name: 'Deep Goat', tagline: 'hi' });
    const human = await insertUser(db);
    const game = await insertGame(db, group.id, human.id, bot.id);

    await deleteBot(deps, owner.id, bot.id);

    const row = await userRow(bot.id);
    expect(row.firstName).toBe('Deleted bot');
    expect(row.tagline).toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(displayName(row)).toBe('🤖 Deleted bot');
    const [ended] = await db.select().from(games).where(eq(games.id, game.id));
    expect(ended).toMatchObject({ status: 'finished', blackId: bot.id, result: '1-0' });
    const again = await createBot(db, owner.id, { name: 'deep goat' });
    expect(again.firstName).toBe('deep goat');
  });

  it('a deleted bot frees its slot', async () => {
    const owner = await insertUser(db);
    const bots = [];
    for (let i = 0; i < 20; i++) bots.push(await createBot(db, owner.id, { name: `Bot ${i}` }));
    await deleteBot(deps, owner.id, bots[0]!.id);
    expect((await createBot(db, owner.id, { name: 'Bot 20' })).firstName).toBe('Bot 20');
    expect(await listBots(db, owner.id)).toHaveLength(20);
  });

  it("deleteBot refuses other owners' bots and already-deleted bots", async () => {
    const a = await insertUser(db);
    const b = await insertUser(db);
    const bot = await insertBot(db, a);
    expect(await reason(deleteBot(deps, b.id, bot.id))).toBe('bot_not_found');
    await deleteBot(deps, a.id, bot.id);
    expect(await reason(deleteBot(deps, a.id, bot.id))).toBe('bot_not_found');
  });
});
