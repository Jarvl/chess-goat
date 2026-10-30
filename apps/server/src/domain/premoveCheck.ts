import {
  PremoveTreeFormatError,
  decodePremoveBytes,
  fromBase64Url,
  premoveTreeCheck,
  type PremoveNode,
  type TreeCheck,
} from '@group-chess/shared';
import { DomainError } from './errors';

/**
 * Runs `premoveTreeCheck` to the end, giving the event loop a turn every `slice` pairs it plays
 * (checked, or replayed to reach a new one): a whole new tree of thousands of pairs takes seconds,
 * and so does one new pair under a line of thousands of stored ones (conditional premoves spec, API).
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

/** Checks the pairs of `tree` that `known` lacks, from `fen`; `illegal_move` with its `path` if one fails. */
export async function requireLegalTree(
  fen: string,
  tree: readonly PremoveNode[],
  known: readonly PremoveNode[],
): Promise<void> {
  const check = await checkTreeYielding(fen, tree, known);
  if (!check.ok) throw new DomainError('illegal_move', 'illegal premove', { path: check.path });
}

/** The tree text as bytes and nodes; null when it does not decode. */
export function parseTree(text: string): { bytes: Uint8Array; tree: PremoveNode[] } | null {
  try {
    const bytes = fromBase64Url(text);
    return { bytes, tree: decodePremoveBytes(bytes) };
  } catch (error) {
    if (error instanceof PremoveTreeFormatError) return null;
    throw error;
  }
}
