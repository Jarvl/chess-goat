import { sideToMove, type TurnKind } from '@chess-goat/shared';
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges, games } from '../db/schema';

/** What identifies a turn: the same bot, kind and position is the same turn. */
export type TurnKey = {
  botId: number;
  kind: TurnKind;
  /** `games.id`, not the public id. */
  gameId: number | null;
  /** `challenges.id`, not the public id. */
  challengeId: number | null;
  ply: number | null;
};

export type PendingTurn = TurnKey & {
  /** A challenge's expiry, or the game's deadline while the bot's own clock runs; else null. */
  deadlineAt: Date | null;
  /** When the turn arose: the challenge's creation, or the game's last move (else its start). */
  since: Date;
};

export function sameTurn(a: TurnKey, b: TurnKey): boolean {
  return (
    a.botId === b.botId &&
    a.kind === b.kind &&
    a.gameId === b.gameId &&
    a.challengeId === b.challengeId &&
    a.ply === b.ply
  );
}

/** Soonest deadline first, none last; then oldest first; then by kind, id and bot. */
function byUrgency(a: PendingTurn, b: PendingTurn): number {
  if (a.deadlineAt?.getTime() !== b.deadlineAt?.getTime()) {
    if (a.deadlineAt === null) return 1;
    if (b.deadlineAt === null) return -1;
    return a.deadlineAt.getTime() - b.deadlineAt.getTime();
  }
  if (a.since.getTime() !== b.since.getTime()) return a.since.getTime() - b.since.getTime();
  // Fully tied: a fixed order, so that repeated reads agree on which turn is first.
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const idA = a.challengeId ?? a.gameId!;
  const idB = b.challengeId ?? b.gameId!;
  return idA !== idB ? idA - idB : a.botId - b.botId;
}

/**
 * Challenge, move and draw-offer turns for these bots, soonest deadline first, none last, then
 * oldest: pending challenges sent to them, active games where one is to move (with or without a
 * draw offer standing), and draw offers made to them on the opponent's move. No page limit: the
 * caller takes the first claimable one. One query per source, whatever the number of bots.
 */
export async function pendingTurns(tx: DbOrTx, botIds: readonly number[]): Promise<PendingTurn[]> {
  if (botIds.length === 0) return [];
  const ids = [...botIds];
  const side = sql`split_part(${games.fen}, ' ', 2)`;
  // The game needs one of the bots: on its move, or answering a draw offer on the opponent's.
  const whiteActs = and(
    inArray(games.whiteId, ids),
    or(sql`${side} = 'w'`, eq(games.drawOfferBy, 'black')),
  );
  const blackActs = and(
    inArray(games.blackId, ids),
    or(sql`${side} = 'b'`, eq(games.drawOfferBy, 'white')),
  );

  const [challengeRows, gameRows] = await Promise.all([
    tx
      .select({
        id: challenges.id,
        botId: challenges.opponentId,
        expiresAt: challenges.expiresAt,
        createdAt: challenges.createdAt,
      })
      .from(challenges)
      .where(
        and(
          eq(challenges.status, 'pending'),
          inArray(challenges.opponentId, ids),
          gt(challenges.expiresAt, sql`now()`),
        ),
      ),
    tx
      .select({
        id: games.id,
        whiteId: games.whiteId,
        blackId: games.blackId,
        fen: games.fen,
        plyCount: games.plyCount,
        deadlineAt: games.deadlineAt,
        drawOfferBy: games.drawOfferBy,
        lastMoveAt: games.lastMoveAt,
        startedAt: games.startedAt,
      })
      .from(games)
      .where(and(eq(games.status, 'active'), or(whiteActs, blackActs))),
  ]);

  const turns: PendingTurn[] = challengeRows.map((row) => ({
    botId: row.botId!,
    kind: 'challenge',
    gameId: null,
    challengeId: row.id,
    ply: null,
    deadlineAt: row.expiresAt,
    since: row.createdAt,
  }));

  for (const game of gameRows) {
    const toMove = sideToMove(game.fen);
    const since = game.lastMoveAt ?? game.startedAt;
    const sides = [
      { colour: 'white' as const, botId: game.whiteId },
      { colour: 'black' as const, botId: game.blackId },
    ];
    for (const { colour, botId } of sides) {
      if (!ids.includes(botId)) continue;
      if (toMove === colour) {
        turns.push({
          botId,
          kind: 'move',
          gameId: game.id,
          challengeId: null,
          ply: game.plyCount,
          deadlineAt: game.deadlineAt,
          since,
        });
      } else if (game.drawOfferBy !== null && game.drawOfferBy !== colour) {
        // The bot's own clock isn't running, so the offer has no deadline for it.
        turns.push({
          botId,
          kind: 'draw_offer',
          gameId: game.id,
          challengeId: null,
          ply: game.plyCount,
          deadlineAt: null,
          since,
        });
      }
    }
  }
  return turns.sort(byUrgency);
}
