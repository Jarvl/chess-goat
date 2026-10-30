import { INITIAL_FEN, type GameResult } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../src/db/client';
import { userFlair, users, type GameRow } from '../../src/db/schema';
import { play } from './chess';
import { insertGame, insertMove, type GameOverrides } from './fixtures';

/** Noon UTC on day `n` of February 2026. */
export const day = (n: number): Date => new Date(Date.UTC(2026, 1, n, 12));

/** A finished game on day `d` whose moves are `line` replayed from `start`; `result` is White's. */
export async function finishedGame(
  db: DbOrTx,
  groupId: number,
  whiteId: number,
  blackId: number,
  d: number,
  result: Exclude<GameResult, '*'>,
  options: { line?: readonly string[]; start?: string; over?: GameOverrides } = {},
): Promise<GameRow> {
  const moves = play(options.start ?? INITIAL_FEN, ...(options.line ?? []));
  const game = await insertGame(db, groupId, whiteId, blackId, {
    status: 'finished',
    result,
    // No flair reads the end reason checkmate (mates are found in the moves), so only a test that
    // asks for a resignation or a timeout earns 🐔 or 💤.
    endReason: 'checkmate',
    // An hour long unless a test says otherwise, well outside 🏎️'s three minutes.
    startedAt: new Date(day(d).getTime() - 3_600_000),
    finishedAt: day(d),
    plyCount: moves.length,
    ...options.over,
  });
  for (const m of moves) await insertMove(db, game.id, m.ply, m.uci, m.san, m.fenAfter);
  return game;
}

/** A player's earned flair as [flair id, game id] pairs, by flair id. */
export async function earned(db: DbOrTx, userId: number): Promise<[string, number | null][]> {
  return (
    await db.select().from(userFlair).where(eq(userFlair.userId, userId)).orderBy(userFlair.flairId)
  ).map((row) => [row.flairId, row.gameId]);
}

/** A player's worn flair, in slot order. */
export async function worn(db: DbOrTx, userId: number): Promise<string[]> {
  return (await db.select({ worn: users.flairWorn }).from(users).where(eq(users.id, userId)))[0]!
    .worn;
}

/**
 * A change to a player's worn list in flight, as a `PUT` makes it: it holds the player's row, with
 * the lock `setWornFlair` takes, until `commit()` is called, then saves `wearing` with it.
 */
export async function startWearing(db: Db, userId: number, wearing: string[]) {
  let commit!: () => void;
  const mayCommit = new Promise<void>((resolve) => (commit = resolve));
  let holding!: () => void;
  const isHolding = new Promise<void>((resolve) => (holding = resolve));
  const done = db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
    holding();
    await mayCommit;
    await tx.update(users).set({ flairWorn: wearing }).where(eq(users.id, userId));
  });
  await Promise.race([isHolding, done]);
  return { commit, done };
}
