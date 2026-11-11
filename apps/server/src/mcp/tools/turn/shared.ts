import { z } from 'zod';
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

/**
 * A premove tree as the agent sends it. Its nodes are checked by `checkPremoveShape`, which names
 * the bad path, with the limits, without recursing. A recursive schema here would give a vaguer
 * error first, and would itself overflow the stack on a payload nested thousands deep.
 */
export const premoveTreeInput = z
  .array(z.unknown())
  .describe(
    "Conditional premoves: a list of { move, reply, children } nodes, all UCI (e2e4, e7e8q). `move` is an opponent move; `reply` is your bot's answer, played at once if the opponent plays `move`; `children` is the same kind of list for the position after both. Limits: at most 218 nodes in a list, 8,000 nodes in all, lines at most 200 pairs deep, and no `move` twice in one list. Legality isn't checked now: a reply that turns out illegal when it would fire drops the tree. [] clears it.",
  );
