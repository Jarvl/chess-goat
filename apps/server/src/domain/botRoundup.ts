import { GLICKO2 } from '@chess-goat/shared';
import { and, eq, gte, gt, inArray, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, ratings, users } from '../db/schema';
import { getBotStandings } from './ratings';
import { displayName } from './users';

export type Roundup = {
  topBot: { label: string; rating: number } | null;
  mostWins: { label: string; wins: number } | null;
  upset: { winner: string; loser: string; gap: number } | null;
  /** Finished bot games in the window. */
  games: number;
};

/**
 * The week's bot games in a group: finished since `since`, not voided, not aborted, with at least
 * one bot side. Null when there were none, so nothing is posted.
 */
export async function buildRoundup(
  tx: DbOrTx,
  groupId: number,
  since: Date,
): Promise<Roundup | null> {
  const rows = await tx
    .select()
    .from(games)
    .where(
      and(
        eq(games.groupId, groupId),
        eq(games.status, 'finished'),
        gte(games.finishedAt, since),
        isNull(games.voidedAt),
        gt(games.botPlayers, 0),
      ),
    );
  const played = rows.filter(
    (game) => game.endReason !== 'abort' && game.endReason !== 'timeout_abort',
  );
  if (played.length === 0) return null;

  const userIds = [...new Set(played.flatMap((game) => [game.whiteId, game.blackId]))];
  const [people, current] = await Promise.all([
    tx.select().from(users).where(inArray(users.id, userIds)),
    tx
      .select({ userId: ratings.userId, rating: ratings.rating })
      .from(ratings)
      .where(and(eq(ratings.groupId, groupId), inArray(ratings.userId, userIds))),
  ]);
  const userOf = new Map(people.map((user) => [user.id, user]));
  const currentRating = new Map(current.map((row) => [row.userId, row.rating]));
  const nameOf = (id: number) => displayName(userOf.get(id)!);
  // The human side of a bot game has no snapshot, so it falls back to its rating row, as the cards do.
  const before = (snapshot: number | null, id: number) =>
    snapshot ?? currentRating.get(id) ?? GLICKO2.initialRating;

  const wins = new Map<number, number>();
  let upset: { winnerId: number; loserId: number; gap: number } | null = null;
  for (const game of played) {
    if (game.result !== '1-0' && game.result !== '0-1') continue;
    const whiteWon = game.result === '1-0';
    const winnerId = whiteWon ? game.whiteId : game.blackId;
    const loserId = whiteWon ? game.blackId : game.whiteId;
    const winner = userOf.get(winnerId)!;
    if (winner.ownerId !== null && !winner.deletedAt)
      wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    const winnerBefore = before(
      whiteWon ? game.whiteRatingBefore : game.blackRatingBefore,
      winnerId,
    );
    const loserBefore = before(whiteWon ? game.blackRatingBefore : game.whiteRatingBefore, loserId);
    const gap = Math.round(loserBefore - winnerBefore);
    if (gap > 0 && (upset === null || gap > upset.gap)) upset = { winnerId, loserId, gap };
  }

  const [leader] = [...wins.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const [top] = await getBotStandings(tx, groupId, 1);
  return {
    games: played.length,
    topBot: top ? { label: top.name, rating: top.rating } : null,
    mostWins: leader ? { label: nameOf(leader[0]), wins: leader[1] } : null,
    upset: upset
      ? { winner: nameOf(upset.winnerId), loser: nameOf(upset.loserId), gap: upset.gap }
      : null,
  };
}
