import {
  INITIAL_FEN,
  analysisUrl,
  computeClaims,
  isProvisional,
  positionKey,
  sideToMove,
  toBase64Url,
  type Colour,
  type GameDto,
  type GamePlayer,
  type TimePerMove,
} from '@group-chess/shared';
import type { GameRow, GroupRow, MoveRow, RatingRow, UserRow } from '../db/schema';
import { toPlayerRef } from './players';

export function colourOf(
  game: Pick<GameRow, 'whiteId' | 'blackId'>,
  userId: number | null,
): Colour | null {
  if (userId === null) return null;
  if (game.whiteId === userId) return 'white';
  if (game.blackId === userId) return 'black';
  return null;
}

const NO_TREE = new Uint8Array();

/**
 * The stored premove tree's bytes, or none when it was stored at another ply (conditional
 * premoves spec, Data): a container that ignores trees can move past one without clearing it.
 */
export function storedPremoveTree(
  game: Pick<GameRow, 'premoveTree' | 'premoveTreePly' | 'plyCount'>,
): Uint8Array {
  return game.premoveTreePly === game.plyCount ? game.premoveTree : NO_TREE;
}

/** Position keys of every position so far, the initial one first (arbiter contract). */
export function positionKeys(moves: readonly MoveRow[]): string[] {
  return [positionKey(INITIAL_FEN), ...moves.map((move) => positionKey(move.fenAfter))];
}

export type GameDtoInput = {
  game: GameRow;
  moves: MoveRow[];
  group: Pick<GroupRow, 'publicId' | 'title'>;
  white: UserRow;
  black: UserRow;
  whiteRating: Pick<RatingRow, 'rating' | 'rd'> | null;
  blackRating: Pick<RatingRow, 'rating' | 'rd'> | null;
  viewerUserId: number | null;
  now: Date;
};

function player(
  user: UserRow,
  live: Pick<RatingRow, 'rating' | 'rd'> | null,
  snapshot: {
    before: number | null;
    after: number | null;
    rdBefore: number | null;
    rdAfter: number | null;
  },
  finishedRated: boolean,
): GamePlayer {
  const useSnapshot =
    finishedRated &&
    snapshot.before !== null &&
    snapshot.after !== null &&
    snapshot.rdBefore !== null &&
    snapshot.rdAfter !== null;
  if (!useSnapshot)
    return { ...toPlayerRef(user, live), ratingAfter: null, provisionalAfter: null };
  return {
    ...toPlayerRef(user, { rating: snapshot.before!, rd: snapshot.rdBefore! }),
    ratingAfter: Math.round(snapshot.after!),
    provisionalAfter: isProvisional(snapshot.rdAfter!),
  };
}

/** The full game DTO of spec §9; the same function serves the REST route and every SSE push. */
export function buildGameDto(input: GameDtoInput): GameDto {
  const { game, moves, group, now } = input;
  // A void reverts the rated effect (spec §7.1), so the delta disappears from the DTO with it.
  const finishedRated = game.status === 'finished' && game.rated && game.voidedAt === null;
  const active = game.status === 'active';
  const viewer = colourOf(game, input.viewerUserId);
  // Premoves always belong to the side not to move, and only their owner may see them.
  const owner = active && viewer !== null && sideToMove(game.fen) !== viewer;
  const dto: GameDto = {
    id: game.publicId,
    group: { id: group.publicId, title: group.title },
    status: game.status,
    white: player(
      input.white,
      input.whiteRating,
      {
        before: game.whiteRatingBefore,
        after: game.whiteRatingAfter,
        rdBefore: game.whiteRdBefore,
        rdAfter: game.whiteRdAfter,
      },
      finishedRated,
    ),
    black: player(
      input.black,
      input.blackRating,
      {
        before: game.blackRatingBefore,
        after: game.blackRatingAfter,
        rdBefore: game.blackRdBefore,
        rdAfter: game.blackRdAfter,
      },
      finishedRated,
    ),
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    fen: game.fen,
    plyCount: game.plyCount,
    version: game.version,
    moves: moves.map((move) => ({
      ply: move.ply,
      uci: move.uci,
      san: move.san,
      fenAfter: move.fenAfter,
      playedAt: move.playedAt.toISOString(),
    })),
    deadlineAt: active && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    serverTime: now.toISOString(),
    drawOffer:
      active && game.drawOfferBy !== null && game.drawOfferPly !== null
        ? { by: game.drawOfferBy, atPly: game.drawOfferPly }
        : null,
    claims: active
      ? computeClaims(game.fen, positionKeys(moves))
      : { threefold: false, fiftyMove: false },
    viewerRole: viewer ?? 'spectator',
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
    startedAt: game.startedAt.toISOString(),
    finishedAt: game.finishedAt ? game.finishedAt.toISOString() : null,
    engineLevel: game.engineLevel,
    premoveTree: owner ? toBase64Url(storedPremoveTree(game)) : '',
  };
  if (game.status === 'finished') {
    if (game.lichessUrl) dto.lichessUrl = game.lichessUrl;
    if (moves.length > 0) dto.analysisUrl = analysisUrl(moves.map((move) => move.san));
  }
  return dto;
}
