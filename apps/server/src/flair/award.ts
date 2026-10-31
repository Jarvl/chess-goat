import { FLAIR, type Colour } from '@chess-goat/shared';
import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { userFlair, users, type GameRow, type UserRow } from '../db/schema';
import { listMoves, requireGameById } from '../domain/games';
import { isCountedGame, loadCountedGames } from './history';
import type { StoredMove } from './patterns';
import { ruleHolds } from './rules';
import { fillFreeSlots } from './worn';

/** What both players of a finished game are scored on. */
type Scoring = {
  game: GameRow;
  finishedAt: Date;
  moves: readonly StoredMove[];
};

/** A player's row as it was when the award locked it. */
type LockedPlayer = Pick<UserRow, 'id' | 'isEngine' | 'deletedAt' | 'flairWorn'>;

/**
 * Flair spec §3.2: scores both players of a finished game against every flair they do not hold yet,
 * stores what they earned and fills their free worn slots. Run it in one transaction, so a rerun
 * or a duplicate job finds the awards already made and changes nothing (spec §6).
 */
export async function awardFlairForGame(
  tx: DbOrTx,
  gameId: number,
  random: () => number = Math.random,
): Promise<void> {
  const game = await requireGameById(tx, gameId);
  // A game voided before its job ran no longer counts, and earns nothing (spec §6).
  if (!isCountedGame(game)) return;
  if (game.finishedAt === null) throw new Error(`game ${game.id} has no finish time`);
  const scoring: Scoring = {
    game,
    finishedAt: game.finishedAt,
    moves: await listMoves(tx, game.id),
  };
  // Both players' rows are locked before anything is read about either, in one statement and in
  // ascending id order whatever their colours (spec §3.2 step 2): two awards for the same pair of
  // players with the colours reversed would otherwise each hold one row while waiting for the
  // other's. A `PUT` of the worn list, Delete my data and another award for either player lock
  // these rows too, so they take turns with this, and everything read below is read after the
  // locks, so it sees what they committed (spec §6). `for no key update` is enough for that, and
  // unlike `for update` it lets through the `for key share` locks of foreign-key checks: games,
  // ratings and other rows that refer to either player can still be written while this runs.
  const locked = await tx
    .select({
      id: users.id,
      isEngine: users.isEngine,
      deletedAt: users.deletedAt,
      flairWorn: users.flairWorn,
    })
    .from(users)
    .where(inArray(users.id, [game.whiteId, game.blackId]))
    .orderBy(users.id)
    .for('no key update');
  for (const side of ['white', 'black'] as const) {
    const userId = side === 'white' ? game.whiteId : game.blackId;
    const player = locked.find((row) => row.id === userId);
    if (player) await awardToPlayer(tx, scoring, side, player, random);
  }
}

/** Flair spec §3.2 step 3: scores one player of the game, stores what they earned and wears it. */
async function awardToPlayer(
  tx: DbOrTx,
  { game, finishedAt, moves }: Scoring,
  side: Colour,
  player: LockedPlayer,
  random: () => number,
): Promise<void> {
  // The bot and a player who deleted their data carry no flair.
  if (player.isEngine || player.deletedAt !== null) return;
  const userId = player.id;
  const heldRows = await tx
    .select({ flairId: userFlair.flairId })
    .from(userFlair)
    .where(eq(userFlair.userId, userId));
  const held = new Set(heldRows.map((row) => row.flairId));
  // Every flair not yet held is a candidate, scored on the player's whole history (backfill spec §5).
  const candidates = FLAIR.filter((flair) => !held.has(flair.id));
  if (candidates.length === 0) return;

  const counted = await loadCountedGames(tx, userId, { through: game });
  const current = counted.at(-1);
  // The rules need this game last (spec §1.6). It is missing if it was voided since it was read.
  if (current === undefined || current.id !== game.id) return;

  const earned = candidates
    .filter((flair) => ruleHolds(flair.rule, { game: current, history: counted, moves, side }))
    .map((flair) => flair.id);
  if (earned.length === 0) return;

  const inserted = await tx
    .insert(userFlair)
    .values(earned.map((flairId) => ({ userId, flairId, gameId: game.id, earnedAt: finishedAt })))
    .onConflictDoNothing()
    .returning({ flairId: userFlair.flairId });
  // Only rows actually inserted are new, and `earned` is in catalog order (spec §3.3).
  const insertedIds = new Set(inserted.map((row) => row.flairId));
  const fresh = earned.filter((id) => insertedIds.has(id));
  if (fresh.length === 0) return;

  const nextWorn = fillFreeSlots(player.flairWorn, fresh, random);
  if (
    nextWorn.length !== player.flairWorn.length ||
    nextWorn.some((id, i) => id !== player.flairWorn[i])
  )
    await tx.update(users).set({ flairWorn: nextWorn }).where(eq(users.id, userId));
}
