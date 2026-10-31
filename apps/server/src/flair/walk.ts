import type { FlairEntry, FlairId } from '@chess-goat/shared';
import type { StoredMove } from './patterns';
import { ruleHolds, type CountedGame } from './rules';

/**
 * Backfill spec §4.2 steps 3–4: walks a player's counted games, oldest first, and finds the first
 * game at which each candidate's rule holds. Scoring each game on the history up to it is correct
 * because a rule depends only on the game and earlier ones (flair spec §1.6).
 *
 * Moves are read only for a game where a candidate that reads them could hold: any game for `made`,
 * a win for `won` and `quickMate`, a loss for `lost`. They are read at most once per game, and the walk stops as soon as every candidate is found.
 */
export async function earliestQualifying(
  history: readonly CountedGame[],
  candidates: readonly FlairEntry[],
  movesOf: (gameId: number) => Promise<readonly StoredMove[]>,
): Promise<Map<FlairId, CountedGame>> {
  const found = new Map<FlairId, CountedGame>();
  let remaining = [...candidates];
  for (let i = 0; i < history.length && remaining.length > 0; i += 1) {
    const game = history[i]!;
    const needsMoves = remaining.some(
      ({ rule }) =>
        rule.kind === 'made' ||
        ((rule.kind === 'won' || rule.kind === 'quickMate') && game.result === 'win') ||
        (rule.kind === 'lost' && game.result === 'loss'),
    );
    const moves = needsMoves ? await movesOf(game.id) : [];
    const context = { game, history: history.slice(0, i + 1), moves, side: game.side };
    const holding = remaining.filter((flair) => ruleHolds(flair.rule, context));
    for (const flair of holding) found.set(flair.id, game);
    remaining = remaining.filter((flair) => !holding.includes(flair));
  }
  return found;
}
