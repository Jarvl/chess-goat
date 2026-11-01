import {
  sideToMove,
  type ChallengeDto,
  type GameSummary,
  type TimePerMove,
} from '@chess-goat/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import {
  challenges,
  games,
  moves,
  ratings,
  users,
  type ChallengeRow,
  type GameRow,
  type RatingRow,
  type UserRow,
} from '../db/schema';
import { toPlayerRef } from './players';

export const whiteUser = alias(users, 'white_user');
export const blackUser = alias(users, 'black_user');
export const whiteRating = alias(ratings, 'white_rating');
export const blackRating = alias(ratings, 'black_rating');

export type GameSummaryRow = {
  game: GameRow;
  white: UserRow;
  black: UserRow;
  whiteRating: RatingRow | null;
  blackRating: RatingRow | null;
  /** UCI of the move at `ply_count`, or null before the first move. */
  lastMove: string | null;
};

/** Games with both players, their current ratings and the last move in one query. */
export async function gameSummaryRows(
  tx: DbOrTx,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
): Promise<GameSummaryRow[]> {
  return tx
    .select({
      game: games,
      white: whiteUser,
      black: blackUser,
      whiteRating,
      blackRating,
      // A primary-key lookup on moves (game_id, ply) per row, for the list thumbnails.
      lastMove: sql<
        string | null
      >`(select ${moves.uci} from ${moves} where ${moves.gameId} = ${games.id} and ${moves.ply} = ${games.plyCount})`,
    })
    .from(games)
    .innerJoin(whiteUser, eq(whiteUser.id, games.whiteId))
    .innerJoin(blackUser, eq(blackUser.id, games.blackId))
    .leftJoin(
      whiteRating,
      and(eq(whiteRating.groupId, games.groupId), eq(whiteRating.userId, games.whiteId)),
    )
    .leftJoin(
      blackRating,
      and(eq(blackRating.groupId, games.groupId), eq(blackRating.userId, games.blackId)),
    )
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);
}

export function toGameSummary(row: GameSummaryRow, viewerId: number | null): GameSummary {
  const { game } = row;
  const side = sideToMove(game.fen);
  const toMove = side === 'white' ? game.whiteId : game.blackId;
  return {
    id: game.publicId,
    white: toPlayerRef(row.white, row.whiteRating),
    black: toPlayerRef(row.black, row.blackRating),
    status: game.status,
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    plyCount: game.plyCount,
    sideToMove: side,
    yourTurn: game.status === 'active' && viewerId !== null && toMove === viewerId,
    deadlineAt: game.status === 'active' && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    lastMoveAt: game.lastMoveAt ? game.lastMoveAt.toISOString() : null,
    startedAt: game.startedAt.toISOString(),
    finishedAt: game.finishedAt ? game.finishedAt.toISOString() : null,
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
    fen: game.fen,
    lastMove: row.lastMove,
    engineLevel: game.engineLevel ?? null,
  };
}

export const challengerUser = alias(users, 'challenger_user');
export const opponentUser = alias(users, 'opponent_user');
export const challengerRating = alias(ratings, 'challenger_rating');
export const opponentRating = alias(ratings, 'opponent_rating');

export type ChallengeDtoRow = {
  challenge: ChallengeRow;
  challenger: UserRow;
  opponent: UserRow | null;
  challengerRating: RatingRow | null;
  opponentRating: RatingRow | null;
};

export async function challengeDtoRows(
  tx: DbOrTx,
  where: SQL | undefined,
  limit: number,
): Promise<ChallengeDtoRow[]> {
  return tx
    .select({
      challenge: challenges,
      challenger: challengerUser,
      opponent: opponentUser,
      challengerRating,
      opponentRating,
    })
    .from(challenges)
    .innerJoin(challengerUser, eq(challengerUser.id, challenges.challengerId))
    .leftJoin(opponentUser, eq(opponentUser.id, challenges.opponentId))
    .leftJoin(
      challengerRating,
      and(
        eq(challengerRating.groupId, challenges.groupId),
        eq(challengerRating.userId, challenges.challengerId),
      ),
    )
    .leftJoin(
      opponentRating,
      and(
        eq(opponentRating.groupId, challenges.groupId),
        eq(opponentRating.userId, challenges.opponentId),
      ),
    )
    .where(where)
    .orderBy(challenges.createdAt)
    .limit(limit);
}

export function challengeToDto(
  row: ChallengeDtoRow,
  viewer: { id: number; username: string | null },
): ChallengeDto {
  const { challenge } = row;
  const pending = challenge.status === 'pending';
  const open = challenge.opponentId === null && challenge.opponentUsername === null;
  // A username challenge is answerable only by whoever holds that username now.
  const named =
    challenge.opponentUsername !== null &&
    viewer.username?.toLowerCase() === challenge.opponentUsername;
  const addressed = challenge.opponentId === viewer.id || named;
  return {
    id: challenge.publicId,
    challenger: toPlayerRef(row.challenger, row.challengerRating),
    opponent: row.opponent ? toPlayerRef(row.opponent, row.opponentRating) : null,
    opponentUsername: challenge.opponentUsername,
    timePerMove: challenge.timePerMove as TimePerMove,
    challengerColour: challenge.challengerColour,
    rated: challenge.rated,
    status: challenge.status,
    createdAt: challenge.createdAt.toISOString(),
    expiresAt: challenge.expiresAt.toISOString(),
    viewer: {
      canAccept: pending && (addressed || (open && challenge.challengerId !== viewer.id)),
      canDecline: pending && addressed,
      canCancel: pending && challenge.challengerId === viewer.id,
    },
  };
}
