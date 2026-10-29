import {
  decodePremoveBytes,
  premoveTreeHash,
  sideToMove,
  type GameDto,
  type PremoveNode,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { colourOf } from './gameDto';
import { loadGameDto, lockActiveGame, requireGameByPublicId } from './games';
import { parseTree, requireLegalTree } from './premoveCheck';

export { checkTreeYielding } from './premoveCheck';

export type SetPremoveTreeInput = {
  gameId: string;
  userId: number;
  /** Fingerprint of the tree the device showed when the player made the edit. */
  baseHash: string;
  /** The tree the device wants, base64url; `''` clears it. */
  tree: string;
  expectedPly: number;
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Checks the pairs of `tree` that the `stored` bytes lack, from `fen`. */
const checkNewPairs = (fen: string, tree: readonly PremoveNode[], stored: Uint8Array) =>
  requireLegalTree(fen, tree, decodePremoveBytes(stored));

/**
 * Compare-and-set of the caller's premove tree (conditional premoves spec, API). The new pairs
 * are checked before the lock, against the stored tree read without it; the locked row is then
 * re-checked in the spec's order, and a tree that does not decode is refused only after those
 * checks. Never bumps the version; an edit is pushed to the owner's streams only, so nothing
 * reaches the opponent.
 */
export async function setPremoveTree(deps: Deps, input: SetPremoveTreeInput): Promise<GameDto> {
  const parsed = parseTree(input.tree);

  // Anything the locked checks below refuse is left to them, so their error is the one reported.
  const seen = await requireGameByPublicId(deps.db, input.gameId);
  const seenColour = colourOf(seen, input.userId);
  let checkedAtPly: number | null = null;
  if (
    parsed &&
    seen.status === 'active' &&
    seenColour !== null &&
    sideToMove(seen.fen) !== seenColour &&
    seen.plyCount === input.expectedPly &&
    (await premoveTreeHash(seen.premoveTree)) === input.baseHash
  ) {
    await checkNewPairs(seen.fen, parsed.tree, seen.premoveTree);
    checkedAtPly = seen.plyCount;
  }

  const outcome: { publish: 'all' | 'owner' | null } = { publish: null };
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) {
      outcome.publish = 'all';
      return loadGameDto(tx, game, input.userId);
    }
    if (sideToMove(game.fen) === colour) throw new DomainError('not_your_turn', 'it is your move');
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    if ((await premoveTreeHash(game.premoveTree)) !== input.baseHash) {
      throw new DomainError('stale_state', 'the premoves have changed', {
        reason: 'premoves_changed',
      });
    }
    if (!parsed) throw new DomainError('validation', 'malformed premove tree');
    if (sameBytes(game.premoveTree, parsed.bytes)) return loadGameDto(tx, game, input.userId);
    // The same ply and fingerprint mean the same position and stored tree as the check above. Only
    // a race (the row changed between the two reads into the state the request expected) skips it.
    if (checkedAtPly !== game.plyCount) {
      await checkNewPairs(game.fen, parsed.tree, game.premoveTree);
    }
    const [updated] = await tx
      .update(games)
      .set({ premoveTree: Buffer.from(parsed.bytes) })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    outcome.publish = 'owner';
    return loadGameDto(tx, updated, input.userId);
  });
  if (outcome.publish === 'all') deps.bus.publish(input.gameId);
  if (outcome.publish === 'owner') deps.bus.publish(input.gameId, { userId: input.userId });
  return dto;
}
