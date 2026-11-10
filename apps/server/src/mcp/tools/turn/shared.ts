import type { GameRow } from '../../../db/schema';
import { requireGameById } from '../../../domain/games';
import { DomainError } from '../../../domain/errors';
import type { TurnCall } from '../../context';

/** The game this turn is about, from the lease's numeric id; the domain functions take the public one. */
export async function turnGame(call: TurnCall): Promise<GameRow> {
  const { gameId } = call.lease;
  // A game turn always has one; a lease without it ended (or this tool is on the wrong kind).
  if (gameId === null) {
    throw new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });
  }
  return call.deps.db.transaction((tx) => requireGameById(tx, gameId));
}
