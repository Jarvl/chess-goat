import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, users } from '../../src/db/schema';
import { loadCountedGames } from '../../src/flair/history';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const day = (n: number) => new Date(Date.UTC(2026, 1, n, 12));

describe('loadCountedGames', () => {
  it('lists a player’s counted games through a game, oldest first, from their side', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const end = (whiteId: number, blackId: number, d: number, over: GameOverrides = {}) =>
      insertGame(db, group.id, whiteId, blackId, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: day(d),
        plyCount: 20,
        ...over,
      });
    const first = await end(alice.id, bob.id, 1);
    const win = await end(alice.id, bob.id, 2, { whiteRatingAfter: 1612.4 });
    const draw = await end(bob.id, alice.id, 3, {
      rated: false,
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
    await end(alice.id, bob.id, 4, { result: '*', endReason: 'abort' });
    await end(alice.id, bob.id, 5, { voidedAt: day(6) });
    await end(alice.id, engine!.id, 5, { rated: false, engineLevel: 'beginner' });
    const loss = await end(bob.id, alice.id, 7, { blackRatingAfter: 1590.2 });
    const later = await end(alice.id, bob.id, 9);
    const rows = await loadCountedGames(db, alice.id, { through: loss });
    expect(rows.map((r) => [r.id, r.result, r.side, r.rated, r.ratingAfter])).toEqual([
      [first.id, 'win', 'white', true, null],
      [win.id, 'win', 'white', true, 1612.4],
      [draw.id, 'draw', 'black', false, null],
      [loss.id, 'loss', 'black', true, 1590.2],
    ]);
    // Each game carries how it ended and who the other side was, from either colour.
    expect(rows.map((r) => [r.endReason, r.opponentId])).toEqual([
      ['resignation', bob.id],
      ['resignation', bob.id],
      ['draw_agreement', bob.id],
      ['resignation', bob.id],
    ]);
    // With no game to stop at, the whole counted history (backfill spec §4.2).
    expect((await loadCountedGames(db, alice.id)).map((r) => r.id)).toEqual([
      first.id,
      win.id,
      draw.id,
      loss.id,
      later.id,
    ]);
  });

  it('orders by finish time, breaks a tie by id and cuts through at the same pair', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const carol = await insertUser(db);
    const end = (whiteId: number, blackId: number, d: number) =>
      insertGame(db, group.id, whiteId, blackId, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: day(d),
        plyCount: 20,
      });
    // The game started first finishes last. The rest finish at the same instant, and one of them is
    // between two other players.
    const last = await end(alice.id, bob.id, 4);
    const first = await end(alice.id, bob.id, 3);
    await end(bob.id, carol.id, 3);
    const second = await end(bob.id, alice.id, 3);
    const third = await end(alice.id, bob.id, 3);
    // Rewrite `first` so the table holds it behind the others: a tie not broken by id would then
    // come back out of order. `black_id` is indexed, so this is not a heap-only update, which index
    // and bitmap scans would still read in `first`'s old place.
    await db.update(games).set({ blackId: carol.id }).where(eq(games.id, first.id));
    const idsThrough = async (through: typeof last) =>
      (await loadCountedGames(db, alice.id, { through })).map((r) => r.id);
    expect(await idsThrough(last)).toEqual([first.id, second.id, third.id, last.id]);
    expect(await idsThrough(second)).toEqual([first.id, second.id]);
  });

  it('refuses a through game that has no finish time', async () => {
    await expect(loadCountedGames(db, 1, { through: { id: 1, finishedAt: null } })).rejects.toThrow(
      'game 1 has no finish time',
    );
  });
});
