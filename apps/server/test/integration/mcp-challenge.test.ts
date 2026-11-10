import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  challenges,
  groupMembers,
  jobs,
  ratings,
  runners,
  users,
  type UserRow,
} from '../../src/db/schema';
import { pendingTurns } from '../../src/domain/turns';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import { touchMember } from '../../src/domain/members';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGroup, insertUser } from '../helpers/fixtures';
import { callTool, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let token: string;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Found = {
  bots: {
    id: number;
    name: string;
    label: string;
    owner: string;
    rating: number;
    online?: boolean;
  }[];
  nextCursor: string | null;
};
const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

async function world() {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const other = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, other.id);
  return { group, other };
}
async function botIn(groupId: number, ownerRow: UserRow, firstName: string, rating?: number) {
  const bot = await insertBot(db, ownerRow, { firstName });
  await touchMember(db, groupId, bot.id);
  if (rating !== undefined) {
    await db.insert(ratings).values({ groupId, userId: bot.id, rating, rd: 100, volatility: 0.06 });
  }
  return bot;
}

describe('find_bots', () => {
  it('searches by name substring, case-insensitively', async () => {
    const { group, other } = await world();
    await botIn(group.id, other, 'Knightmare');
    await botIn(group.id, other, 'Bishop');
    const out = await call<Found>('find_bots', { group: group.publicId, query: 'NIGHT' });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.bots.map((b) => b.name)).toEqual(['Knightmare']);
    expect(out.structuredContent!.bots[0]).toMatchObject({ owner: '@bob', rating: 1500 });
    expect(out.structuredContent!.nextCursor).toBeNull();
  });

  it.each(['rating', 'active', 'newest'] as const)('paginates 25 bots by %s', async (sort) => {
    const { group, other } = await world();
    for (let i = 0; i < 25; i++) {
      const bot = await botIn(group.id, other, `Bot${String(i).padStart(2, '0')}`, 1000 + (i % 5));
      if (sort === 'active') {
        await db
          .update(users)
          .set({ lastActiveAt: new Date(Date.now() - (i % 7) * 60_000) })
          .where(eq(users.id, bot.id));
      }
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await call<Found>('find_bots', {
        group: group.publicId,
        sort,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      expect(out.isError).toBeFalsy();
      seen.push(...out.structuredContent!.bots.map((b) => b.id));
      cursor = out.structuredContent!.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('sorts by rating, highest first', async () => {
    const { group, other } = await world();
    await botIn(group.id, other, 'Low', 1200);
    await botIn(group.id, other, 'High', 1900);
    await botIn(group.id, other, 'Mid', 1500);
    const out = await call<Found>('find_bots', { group: group.publicId });
    expect(out.structuredContent!.bots.map((b) => b.name)).toEqual(['High', 'Mid', 'Low']);
  });

  it('lists online bots first within the page, keeping the database order otherwise', async () => {
    const { group, other } = await world();
    await botIn(group.id, other, 'High', 1900);
    const low = await botIn(group.id, other, 'Low', 1200);
    await botIn(group.id, other, 'Mid', 1500);
    await db.insert(runners).values({
      ownerId: other.id,
      label: 'Runner',
      credentialHash: Buffer.from('x'),
      botIds: [low.id],
      lastSeenAt: new Date(),
    });
    const out = await call<Found>('find_bots', { group: group.publicId });
    expect(out.structuredContent!.bots.map((b) => [b.name, b.online])).toEqual([
      ['Low', true],
      ['High', false],
      ['Mid', false],
    ]);
    expect(resultText(out)).toMatch(
      /^Low \(id \d+, 1200\) by @bob \(online\)\nHigh .* \(offline\)/,
    );
  });

  it('hides blocked bots, bots of blocked owners and bots that have left', async () => {
    const { group, other } = await world();
    await botIn(group.id, other, 'Shown');
    const blocked = await botIn(group.id, other, 'Blocked');
    const left = await botIn(group.id, other, 'Left');
    const stranger = await insertUser(db);
    await touchMember(db, group.id, stranger.id);
    await botIn(group.id, stranger, 'OwnerBlocked');
    await db
      .update(groupMembers)
      .set({ blockedAt: new Date() })
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, blocked.id)));
    await db
      .update(groupMembers)
      .set({ blockedAt: new Date() })
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, stranger.id)));
    await db
      .update(groupMembers)
      .set({ status: 'left' })
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, left.id)));
    const out = await call<Found>('find_bots', { group: group.publicId });
    expect(out.structuredContent!.bots.map((b) => b.name)).toEqual(['Shown']);
  });

  it('says so when the group has no other bots', async () => {
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const out = await call('find_bots', { group: group.publicId });
    expect(resultText(out)).toBe(
      'No other bots in this group yet. People can still challenge yours.',
    );
  });

  it('is refused for a group the owner is not in', async () => {
    const group = await insertGroup(db);
    const out = await call('find_bots', { group: group.publicId });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('member of that group');
  });

  it('rejects a bad cursor', async () => {
    const { group } = await world();
    const out = await call('find_bots', { group: group.publicId, cursor: 'nope' });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('cursor');
  });
});

describe('challenge_bot', () => {
  it('creates a silent bot-vs-bot challenge that is a challenge turn for the opponent', async () => {
    const { group, other } = await world();
    const mine = await botIn(group.id, owner, 'Rook');
    const theirs = await botIn(group.id, other, 'Pawn');
    const out = await call<{ challengeId: string; expiresAt: string }>('challenge_bot', {
      bot: 'Rook',
      opponent_bot: theirs.id,
      group: group.publicId,
    });
    expect(out.isError).toBeFalsy();
    const [row] = await db.select().from(challenges);
    expect(row).toMatchObject({
      challengerId: mine.id,
      opponentId: theirs.id,
      timePerMove: null,
      challengerColour: 'random',
      rated: true,
      botPlayers: 2,
    });
    expect(out.structuredContent).toEqual({
      challengeId: row!.publicId,
      expiresAt: row!.expiresAt.toISOString(),
    });
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect(resultText(out)).toBe(
      `Challenge ${row!.publicId} sent. It expires at ${row!.expiresAt.toISOString()}. Your bot's runner plays the game once the other bot accepts.`,
    );
    // The opponent bot's runner gets it as a challenge turn.
    expect(await pendingTurns(db, [theirs.id])).toMatchObject([
      { kind: 'challenge', challengeId: row!.id },
    ]);
  });

  it('treats a person, an unknown id and a bot outside the group alike', async () => {
    const { group, other } = await world();
    await botIn(group.id, owner, 'Rook');
    const outside = await insertBot(db, other, { firstName: 'Elsewhere' });
    const deleted = await botIn(group.id, other, 'Gone');
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id));
    const texts: string[] = [];
    for (const opponent of [other.id, 999_999, outside.id, deleted.id]) {
      const out = await call('challenge_bot', {
        bot: 'Rook',
        opponent_bot: opponent,
        group: group.publicId,
      });
      expect(out.isError).toBe(true);
      texts.push(resultText(out));
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe('Opponent bot not found. Use a bot id from find_bots for that group.');
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('says a bot cannot challenge itself', async () => {
    const { group } = await world();
    const mine = await botIn(group.id, owner, 'Rook');
    const out = await call('challenge_bot', {
      bot: 'Rook',
      opponent_bot: mine.id,
      group: group.publicId,
    });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      "Cannot challenge yourself. A bot can't challenge itself. Pick a different bot from find_bots.",
    );
  });
});
