import { FLAIR, MAX_WORN_FLAIR, flairById, type FlairDto } from '@chess-goat/shared';
import { and, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import { games, userFlair, users } from '../db/schema';
import { DomainError } from '../domain/errors';
import { displayName, requireUser } from '../domain/users';

/**
 * Flair spec §4: what the player wears, in slot order, and what they have earned, in catalog order
 * and with the other player of the earning game. Stored ids the catalog no longer has are left
 * out of both (spec §1.7), so the app never has to skip one, and no more than three worn are sent,
 * which the app would refuse.
 */
export async function loadFlairDto(tx: DbOrTx, userId: number): Promise<FlairDto> {
  const user = await requireUser(tx, userId);
  const opponent = alias(users, 'opponent');
  const rows = await tx
    .select({
      flairId: userFlair.flairId,
      earnedAt: userFlair.earnedAt,
      opponent: {
        firstName: opponent.firstName,
        username: opponent.username,
        deletedAt: opponent.deletedAt,
      },
    })
    .from(userFlair)
    .innerJoin(games, eq(games.id, userFlair.gameId))
    // The other player of the earning game, whichever colour the player had.
    .innerJoin(
      opponent,
      or(
        and(eq(games.whiteId, userId), eq(opponent.id, games.blackId)),
        and(eq(games.blackId, userId), eq(opponent.id, games.whiteId)),
      ),
    )
    .where(eq(userFlair.userId, userId));
  const earnedById = new Map(rows.map((row) => [row.flairId, row]));
  return {
    worn: user.flairWorn.filter((id) => flairById(id) !== undefined).slice(0, MAX_WORN_FLAIR),
    // Walking the catalog puts the rows in catalog order and drops ids it no longer has.
    earned: FLAIR.flatMap(({ id }) => {
      const row = earnedById.get(id);
      return row
        ? [{ id, earnedAt: row.earnedAt.toISOString(), opponent: displayName(row.opponent) }]
        : [];
    }),
  };
}

/**
 * Flair spec §4: replaces the worn list, in slot order, and answers with the player's flair. The
 * route has already refused a list longer than `MAX_WORN_FLAIR`. Run it in a transaction.
 *
 * The player's row is locked before anything is read or written, as the award job locks it (spec
 * §3.2): an award for the same player waits for this to commit and then fills the free slots from
 * the list left here, and this reads the flair the player holds after any award before it (spec §6).
 * Like the award's, the lock is `for no key update`, which lets through the `for key share` locks
 * of foreign-key checks, so rows that refer to the player can still be written meanwhile.
 */
export async function setWornFlair(
  tx: DbOrTx,
  userId: number,
  worn: readonly string[],
): Promise<FlairDto> {
  const [locked] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (!locked) throw new DomainError('not_found', 'user not found', { userId });

  const refuse = (reason: 'duplicate' | 'unknown' | 'not_earned') =>
    new DomainError('validation', 'invalid flair', { reason });
  if (new Set(worn).size !== worn.length) throw refuse('duplicate');
  if (worn.some((id) => flairById(id) === undefined)) throw refuse('unknown');
  const heldRows = await tx
    .select({ flairId: userFlair.flairId })
    .from(userFlair)
    .where(eq(userFlair.userId, userId));
  const held = new Set(heldRows.map((row) => row.flairId));
  if (worn.some((id) => !held.has(id))) throw refuse('not_earned');

  await tx
    .update(users)
    .set({ flairWorn: [...worn] })
    .where(eq(users.id, userId));
  return loadFlairDto(tx, userId);
}
