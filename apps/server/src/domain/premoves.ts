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
import { colourOf, storedPremoveTree } from './gameDto';
import { loadGameDto, lockActiveGame, requireGameByPublicId } from './games';
import { hasUncheckedPairs, parseTree, requireLegalTree } from './premoveCheck';

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
 * checks. The tree is never checked under the lock. Never bumps the version; an edit is pushed to
 * the owner's streams only, so nothing reaches the opponent.
 */
export async function setPremoveTree(deps: Deps, input: SetPremoveTreeInput): Promise<GameDto> {
  const parsed = parseTree(input.tree);

  // Anything the locked checks below refuse is left to them, so their error is the one reported.
  const seen = await requireGameByPublicId(deps.db, input.gameId);
  const seenColour = colourOf(seen, input.userId);
  const seenTree = storedPremoveTree(seen);
  // The ply the new pairs were checked at, against the stored tree whose fingerprint is `baseHash`.
  let checkedAtPly: number | null = null;
  if (
    parsed &&
    seen.status === 'active' &&
    seenColour !== null &&
    sideToMove(seen.fen) !== seenColour &&
    seen.plyCount === input.expectedPly &&
    (await premoveTreeHash(seenTree)) === input.baseHash
  ) {
    await checkNewPairs(seen.fen, parsed.tree, seenTree);
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
    const storedTree = storedPremoveTree(game);
    if ((await premoveTreeHash(storedTree)) !== input.baseHash) {
      throw new DomainError('stale_state', 'the premoves have changed', {
        reason: 'premoves_changed',
      });
    }
    if (!parsed) throw new DomainError('validation', 'malformed premove tree');
    if (sameBytes(storedTree, parsed.bytes)) return loadGameDto(tx, game, input.userId);
    // The same ply and fingerprint mean the same position and stored tree as the check above. Only
    // a race (the row changed between the two reads into the state the request expected) leaves
    // this state unchecked. Checking here would hold the row lock and a connection for as long as
    // the tree takes, so a tree with anything to check is refused and the device reloads.
    if (
      checkedAtPly !== game.plyCount &&
      hasUncheckedPairs(parsed.tree, decodePremoveBytes(storedTree))
    ) {
      throw new DomainError('stale_state', 'the premoves have changed', {
        reason: 'premoves_changed',
      });
    }
    const [updated] = await tx
      .update(games)
      .set({ premoveTree: Buffer.from(parsed.bytes), premoveTreePly: game.plyCount })
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
