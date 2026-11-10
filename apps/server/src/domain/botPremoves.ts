import { encodePremoveBytes, sideToMove, type PremoveNode } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { games, type GameRow } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { lockActiveGame } from './games';

/** Moves in a bot's premove tree are UCI. */
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
/** One count byte per sibling list in the stored codec. */
export const MAX_PREMOVE_CHILDREN = 218;
export const MAX_PREMOVE_PAIRS = 8000;
/**
 * Pairs on any root-to-leaf line (400 plies), far beyond any real premove line. It keeps every
 * recursive reader of a stored tree (the GameView's output schema, JSON) well inside the stack.
 */
export const MAX_PREMOVE_DEPTH = 200;

const refuse = (
  path: string,
  problem: string,
  reason: 'invalid_premove_tree' | 'premove_too_deep' = 'invalid_premove_tree',
) => new DomainError('validation', `premove tree ${path}: ${problem}`, { reason, path });

/** A value for an error message; never walks into it, as it may be nested arbitrarily deep. */
const shown = (value: unknown): string =>
  typeof value === 'string'
    ? JSON.stringify(value.slice(0, 20))
    : value === undefined
      ? 'nothing'
      : Array.isArray(value)
        ? 'a list'
        : typeof value === 'object' && value !== null
          ? 'an object'
          : String(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the shape of a tree an agent sent, never its legality: a list of
 * `{ move, reply, children }` with UCI moves, no opponent move twice among siblings, at most 218
 * children at any node, 8,000 pairs in all and lines at most 200 pairs deep. Returns the tree as
 * plain nodes, extra keys dropped; throws `validation` naming the first bad path, like
 * `tree[0].children[1].reply` (reason `premove_too_deep` for a line too deep). Walks with its own
 * stack and never recurses into the input: a hostile payload may be nested thousands deep, so this
 * runs before anything recursive (zod, JSON.stringify) sees the tree.
 */
export function checkPremoveShape(tree: unknown): PremoveNode[] {
  const root: PremoveNode[] = [];
  /** `depth` is the number of pairs on the line down to and including the list's nodes. */
  const pending: { list: unknown; path: string; into: PremoveNode[]; depth: number }[] = [
    { list: tree, path: 'tree', into: root, depth: 1 },
  ];
  let pairs = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { list, path, into, depth } = next;
    if (!Array.isArray(list)) throw refuse(path, 'must be a list of { move, reply, children }');
    if (list.length > 0 && depth > MAX_PREMOVE_DEPTH) {
      throw refuse(
        `${path}[0]`,
        `lines may be at most ${MAX_PREMOVE_DEPTH} pairs deep`,
        'premove_too_deep',
      );
    }
    if (list.length > MAX_PREMOVE_CHILDREN) {
      throw refuse(path, `has ${list.length} entries; at most ${MAX_PREMOVE_CHILDREN} are allowed`);
    }
    const seen = new Set<string>();
    list.forEach((entry: unknown, index) => {
      const at = `${path}[${index}]`;
      if (!isRecord(entry)) throw refuse(at, 'must be { move, reply, children }');
      for (const key of ['move', 'reply'] as const) {
        const uci = entry[key];
        if (typeof uci !== 'string' || !UCI.test(uci)) {
          throw refuse(`${at}.${key}`, `${shown(uci)} is not a UCI move like e2e4 or e7e8q`);
        }
      }
      const move = entry.move as string;
      if (seen.has(move)) throw refuse(`${at}.move`, `${move} appears twice among its siblings`);
      seen.add(move);
      pairs += 1;
      if (pairs > MAX_PREMOVE_PAIRS) {
        throw refuse(at, `the tree has more than ${MAX_PREMOVE_PAIRS} pairs`);
      }
      const node: PremoveNode = { move, reply: entry.reply as string, children: [] };
      into.push(node);
      pending.push({
        list: entry.children,
        path: `${at}.children`,
        into: node.children,
        depth: depth + 1,
      });
    });
  }
  return root;
}

export type SetBotPremovesInput = {
  gameId: string;
  botId: number;
  expectedPly: number;
  /** The tree as the agent sent it; checked here for shape only. Empty clears the stored tree. */
  tree: unknown;
};

/**
 * Stores a bot's premove tree, replacing whatever it had. Unlike the app's
 * `setPremoveTree` there is no fingerprint to compare and no legality check: the tree's shape is
 * checked here, and each reply's legality as it fires. Allowed only on the opponent's turn, as in
 * the app. Returns the row; the edit is pushed to the bot's own streams only.
 */
export async function setBotPremoves(deps: Deps, input: SetBotPremovesInput): Promise<GameRow> {
  const bytes = encodePremoveBytes(checkPremoveShape(input.tree));
  const outcome: { publish: 'all' | 'owner' | null } = { publish: null };
  const row = await deps.db.transaction(async (tx) => {
    const { game, colour, ended } = await lockActiveGame(tx, input.gameId, input.botId);
    if (ended) {
      outcome.publish = 'all';
      return game;
    }
    if (sideToMove(game.fen) === colour) {
      throw new DomainError('not_your_turn', 'it is your move', {
        reason: 'premoves_on_your_turn',
      });
    }
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    const [updated] = await tx
      .update(games)
      .set({
        premoveTree: Buffer.from(bytes),
        // No premoveFailure to clear: one names the side to move, and that side moved (clearing
        // it) before it could get here, on the opponent's turn.
        premoveTreePly: game.plyCount,
      })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    outcome.publish = 'owner';
    return updated;
  });
  if (outcome.publish === 'all') deps.bus.publish(input.gameId);
  if (outcome.publish === 'owner') deps.bus.publish(input.gameId, { userId: input.botId });
  return row;
}
