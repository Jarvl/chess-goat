import { encodePremoveBytes, sideToMove, type PremoveNode } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { games, type GameRow } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { lockActiveGame } from './games';

/** Moves in a bot's premove tree are UCI (bots spec §3). */
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
/** One count byte per sibling list in the stored codec. */
export const MAX_PREMOVE_CHILDREN = 218;
export const MAX_PREMOVE_PAIRS = 8000;

const refuse = (path: string, problem: string) =>
  new DomainError('validation', `premove tree ${path}: ${problem}`, {
    reason: 'invalid_premove_tree',
    path,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the shape of a tree an agent sent, never its legality (bots spec §3): a list of
 * `{ move, reply, children }` with UCI moves, no opponent move twice among siblings, at most 218
 * children at any node and 8,000 pairs in all. Returns the tree as plain nodes, extra keys dropped;
 * throws `validation` naming the first bad path, like `tree[0].children[1].reply`. Walks with its
 * own stack: a line may be thousands of plies deep.
 */
export function checkPremoveShape(tree: unknown): PremoveNode[] {
  const root: PremoveNode[] = [];
  const pending: { list: unknown; path: string; into: PremoveNode[] }[] = [
    { list: tree, path: 'tree', into: root },
  ];
  let pairs = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { list, path, into } = next;
    if (!Array.isArray(list)) throw refuse(path, 'must be a list of { move, reply, children }');
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
          throw refuse(
            `${at}.${key}`,
            `${JSON.stringify(uci) ?? 'nothing'} is not a UCI move like e2e4 or e7e8q`,
          );
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
      pending.push({ list: entry.children, path: `${at}.children`, into: node.children });
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
 * Stores a bot's premove tree, replacing whatever it had (bots spec §3). Unlike the app's
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
    if (sideToMove(game.fen) === colour) throw new DomainError('not_your_turn', 'it is your move');
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    const [updated] = await tx
      .update(games)
      .set({
        premoveTree: Buffer.from(bytes),
        premoveTreePly: game.plyCount,
        ...(game.premoveFailure?.botId === input.botId ? { premoveFailure: null } : {}),
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
