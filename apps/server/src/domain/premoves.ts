import {
  PremoveTreeFormatError,
  decodePremoveBytes,
  fromBase64Url,
  premoveTreeCheck,
  premoveTreeHash,
  sideToMove,
  type GameDto,
  type PremoveNode,
  type TreeCheck,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { colourOf } from './gameDto';
import { loadGameDto, lockActiveGame, requireGameByPublicId } from './games';

export type SetPremoveTreeInput = {
  gameId: string;
  userId: number;
  /** Fingerprint of the tree the device showed when the player made the edit. */
  baseHash: string;
  /** The tree the device wants, base64url; `''` clears it. */
  tree: string;
  expectedPly: number;
};

/**
 * Runs `premoveTreeCheck` to the end, giving the event loop a turn every `slice` checked pairs:
 * a whole new tree of thousands of pairs takes seconds (conditional premoves spec, API).
 */
export async function checkTreeYielding(
  fen: string,
  tree: readonly PremoveNode[],
  known: readonly PremoveNode[],
  slice = 256,
): Promise<TreeCheck> {
  const generator = premoveTreeCheck(fen, tree, known);
  for (let checked = 1; ; checked += 1) {
    const step = generator.next();
    if (step.done) return step.value;
    if (checked % slice === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The codec's empty tree: a single zero count. */
const EMPTY_TREE = Uint8Array.of(0);
const isEmptyTree = (bytes: Uint8Array) => bytes.length === 0 || sameBytes(bytes, EMPTY_TREE);
const EMPTY_TREE_HASHES = Promise.all([new Uint8Array(), EMPTY_TREE].map(premoveTreeHash));

/**
 * The tree in `games.premove_tree`. No bytes at all (the column default, and what is stored for an
 * empty tree) is the empty tree, which the codec writes as a single zero count.
 */
export const storedPremoveTree = (bytes: Uint8Array): PremoveNode[] =>
  bytes.length === 0 ? [] : decodePremoveBytes(bytes);

/**
 * Whether `baseHash` fingerprints the stored tree. The empty tree is the one tree with two byte
 * forms, none and the codec's single zero count, and a device may have hashed either.
 */
async function fingerprintMatches(stored: Uint8Array, baseHash: string): Promise<boolean> {
  if (isEmptyTree(stored)) return (await EMPTY_TREE_HASHES).includes(baseHash);
  return baseHash === (await premoveTreeHash(stored));
}

/** Checks the pairs of `tree` that `stored` lacks, from `fen`. */
async function checkNewPairs(fen: string, tree: readonly PremoveNode[], stored: Uint8Array) {
  const check = await checkTreeYielding(fen, tree, storedPremoveTree(stored));
  if (!check.ok) throw new DomainError('illegal_move', 'illegal premove', { path: check.path });
}

/**
 * Compare-and-set of the caller's premove tree (conditional premoves spec, API). The new pairs
 * are checked before the lock, against the stored tree read without it; the locked row is then
 * re-checked in the spec's order. Never bumps the version; an edit is pushed to the owner's
 * streams only, so nothing reaches the opponent.
 */
export async function setPremoveTree(deps: Deps, input: SetPremoveTreeInput): Promise<GameDto> {
  let tree: PremoveNode[];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(input.tree);
    tree = storedPremoveTree(bytes);
  } catch (error) {
    if (error instanceof PremoveTreeFormatError)
      throw new DomainError('validation', 'malformed premove tree');
    throw error;
  }
  // An empty tree is stored as no bytes, like the column default.
  if (tree.length === 0) bytes = new Uint8Array();

  // Anything the locked checks below refuse is left to them, so their error is the one reported.
  const seen = await requireGameByPublicId(deps.db, input.gameId);
  const seenColour = colourOf(seen, input.userId);
  let checkedAtPly: number | null = null;
  if (
    seen.status === 'active' &&
    seenColour !== null &&
    sideToMove(seen.fen) !== seenColour &&
    seen.plyCount === input.expectedPly &&
    (await fingerprintMatches(seen.premoveTree, input.baseHash))
  ) {
    await checkNewPairs(seen.fen, tree, seen.premoveTree);
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
    if (!(await fingerprintMatches(game.premoveTree, input.baseHash))) {
      throw new DomainError('stale_state', 'the premoves have changed', {
        reason: 'premoves_changed',
      });
    }
    const unchanged =
      sameBytes(game.premoveTree, bytes) || (bytes.length === 0 && isEmptyTree(game.premoveTree));
    if (unchanged) return loadGameDto(tx, game, input.userId);
    // The same ply and fingerprint mean the same position and stored tree as the check above. Only
    // a race (the row changed between the two reads into the state the request expected) skips it.
    if (checkedAtPly !== game.plyCount) await checkNewPairs(game.fen, tree, game.premoveTree);
    const [updated] = await tx
      .update(games)
      .set({ premoveTree: Buffer.from(bytes) })
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
