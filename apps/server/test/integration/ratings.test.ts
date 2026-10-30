import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, ratings, type GameRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import {
  applyGameResultToRatings,
  getLeaderboard,
  rebuildGroupRatings,
} from '../../src/domain/ratings';
import { resign } from '../../src/domain/games';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, world } from '../helpers/fixtures';
import { AFTER_E4_E5 } from '../helpers/chess';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const finishedAt = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

async function finished(
  groupId: number,
  whiteId: number,
  blackId: number,
  result: '1-0' | '0-1' | '1/2-1/2' | '*',
  endReason: GameRow['endReason'],
  day: number,
  rated = true,
): Promise<GameRow> {
  const game = await insertGame(db, groupId, whiteId, blackId, {
    rated,
    status: 'finished',
    result,
    endReason,
    finishedAt: finishedAt(day),
    plyCount: 30,
  });
  return game;
}

const reload = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('applyGameResultToRatings', () => {
  it('rates a decisive rated game and stores the snapshots on the game', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1);

    const snapshot = await applyGameResultToRatings(db, game, finishedAt(1));

    expect(snapshot?.white.after.rating).toBeGreaterThan(1500);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed, r.wins, r.losses])).toEqual([
      [alice.id, 1, 1, 0],
      [bob.id, 1, 0, 1],
    ]);
    const stored = await reload(game.id);
    expect(stored.whiteRatingBefore).toBe(1500);
    expect(stored.whiteRdBefore).toBe(350);
    expect(stored.whiteRatingAfter).toBeCloseTo(rows[0]!.rating, 9);
    expect(stored.blackRatingAfter).toBeCloseTo(rows[1]!.rating, 9);
  });

  it('does nothing for a casual game', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1, false);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect((await reload(game.id)).whiteRatingAfter).toBeNull();
  });

  it('does nothing for an aborted rated game', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await finished(group.id, alice.id, bob.id, '*', 'abort', 1);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('concurrent results', () => {
  it('serialises two game ends that share a player so neither update is lost', async () => {
    for (let round = 0; round < 3; round += 1) {
      await truncateAll(db);
      const { group, alice, bob, carol } = await world(db, { game: false });
      const a = await insertGame(db, group.id, alice.id, bob.id, { fen: AFTER_E4_E5, plyCount: 2 });
      const b = await insertGame(db, group.id, alice.id, carol.id, {
        fen: AFTER_E4_E5,
        plyCount: 2,
      });
      await Promise.all([
        resign(deps, { gameId: a.publicId, userId: bob.id }),
        resign(deps, { gameId: b.publicId, userId: carol.id }),
      ]);
      const [aliceRow] = await db
        .select()
        .from(ratings)
        .where(and(eq(ratings.groupId, group.id), eq(ratings.userId, alice.id)));
      expect(aliceRow?.gamesPlayed).toBe(2);
      const [first, second] = [await reload(a.id), await reload(b.id)].sort(
        (x, y) => x.whiteRatingBefore! - y.whiteRatingBefore!,
      );
      expect(first!.whiteRatingBefore).toBe(1500);
      expect(second!.whiteRatingBefore).toBeCloseTo(first!.whiteRatingAfter!, 6);
      expect(aliceRow?.rating).toBeCloseTo(second!.whiteRatingAfter!, 6);
    }
  });
});

describe('rebuildGroupRatings', () => {
  it('rewrites later games’ snapshots after a void', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    const b = await finished(group.id, bob.id, carol.id, '1-0', 'resignation', 2);
    const c = await finished(group.id, carol.id, alice.id, '1/2-1/2', 'draw_agreement', 3);
    for (const game of [a, b, c]) await applyGameResultToRatings(db, game, game.finishedAt!);
    const carolBeforeVoid = (await reload(c.id)).whiteRatingBefore;
    const aliceAfterA = (await reload(a.id)).whiteRatingAfter;
    expect(carolBeforeVoid).toBeLessThan(1500);

    await db
      .update(games)
      .set({ voidedAt: sql`now()`, voidedBy: alice.id })
      .where(eq(games.id, b.id));
    const { changedGameIds } = await rebuildGroupRatings(db, group.id);

    expect(changedGameIds).toEqual([c.id]);
    expect((await reload(c.id)).whiteRatingBefore).toBe(1500);
    expect((await reload(a.id)).whiteRatingAfter).toBeCloseTo(aliceAfterA ?? 0, 9);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed])).toEqual([
      [alice.id, 2],
      [bob.id, 1],
      [carol.id, 1],
    ]);
  });

  it('removes rating rows for players whose games were all voided', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    await applyGameResultToRatings(db, a, finishedAt(1));
    await db
      .update(games)
      .set({ voidedAt: sql`now()` })
      .where(eq(games.id, a.id));
    await rebuildGroupRatings(db, group.id);
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('getLeaderboard', () => {
  it('ranks everyone with a rated game, provisional or not, and hides deleted players', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    const dave = await insertUser(db, { firstName: 'Dave', deletedAt: new Date() });
    const erin = await insertUser(db, { firstName: 'Erin' });
    for (const user of [alice, bob, carol, dave, erin]) await touchMember(db, group.id, user.id);
    await db.insert(ratings).values([
      {
        groupId: group.id,
        userId: alice.id,
        rating: 1550,
        rd: 80,
        volatility: 0.06,
        gamesPlayed: 6,
        wins: 4,
        draws: 1,
        losses: 1,
      },
      {
        groupId: group.id,
        userId: bob.id,
        rating: 1600,
        rd: 90,
        volatility: 0.06,
        gamesPlayed: 5,
        wins: 5,
        draws: 0,
        losses: 0,
      },
      {
        groupId: group.id,
        userId: carol.id,
        rating: 1700,
        rd: 200,
        volatility: 0.06,
        gamesPlayed: 2,
        wins: 2,
        draws: 0,
        losses: 0,
      },
      {
        groupId: group.id,
        userId: dave.id,
        rating: 1800,
        rd: 50,
        volatility: 0.06,
        gamesPlayed: 9,
        wins: 9,
        draws: 0,
        losses: 0,
      },
      // A row left with no games, as after every one of Erin's games was voided.
      {
        groupId: group.id,
        userId: erin.id,
        rating: 1500,
        rd: 350,
        volatility: 0.06,
        gamesPlayed: 0,
        wins: 0,
        draws: 0,
        losses: 0,
      },
    ]);
    const board = await getLeaderboard(db, group.id);
    expect(board.map((e) => [e.name, e.rating, e.gamesPlayed, e.provisional])).toEqual([
      ['Carol', 1700, 2, true],
      ['Bob', 1600, 5, false],
      ['Alice', 1550, 6, false],
    ]);
    expect(board[2]?.record).toEqual({ wins: 4, draws: 1, losses: 1 });
  });
});
