import { computeClaims, opposite, sideToMove, type Colour, type GameDto } from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import { games, type GameRow } from '../db/schema';
import type { Deps } from './deps';
import { isEngineGame } from './engineGames';
import { DomainError } from './errors';
import { positionKeys } from './gameDto';
import { enqueue } from '../jobs/queue';
import { finishGame, listMoves, loadGameDto, lockActiveGame, type EndInput } from './games';

type OfferState = Pick<
  GameRow,
  'drawOfferBy' | 'lastDrawOfferPlyWhite' | 'lastDrawOfferPlyBlack' | 'plyCount'
>;

/** Spec §7.1/§7.8: no offer while one stands, and at most one offer per own move. */
export function canOfferDraw(game: OfferState, colour: Colour): boolean {
  if (game.drawOfferBy !== null) return false;
  const last = colour === 'white' ? game.lastDrawOfferPlyWhite : game.lastDrawOfferPlyBlack;
  if (last === null) return true;
  // White moves on odd plies and Black on even ones; the player must have made a move after the offer.
  const ownParity = colour === 'white' ? 1 : 0;
  const nextOwnPly = last % 2 === ownParity ? last + 2 : last + 1;
  return game.plyCount >= nextOwnPly;
}

type Input = { gameId: string; userId: number };

export async function offerDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    // Spec §8: the bot never takes a draw, so there is nothing to offer it.
    if (isEngineGame(game)) {
      throw new DomainError('validation', 'the bot does not take draws', {
        reason: 'engine_game',
      });
    }
    if (!canOfferDraw(game, colour)) {
      throw new DomainError('forbidden', 'a draw offer is not available now', {
        reason: 'draw_offer_unavailable',
      });
    }
    const [updated] = await tx
      .update(games)
      .set({
        drawOfferBy: colour,
        drawOfferPly: game.plyCount,
        ...(colour === 'white'
          ? { lastDrawOfferPlyWhite: game.plyCount }
          : { lastDrawOfferPlyBlack: game.plyCount }),
        version: sql`${games.version} + 1`,
      })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    // DM notifications spec §2.4: an offer made while the recipient is to move is a DM of its own;
    // one made by the player to move rides on the recipient's next turn DM.
    if (sideToMove(game.fen) !== colour) {
      const recipientId = opposite(colour) === 'white' ? game.whiteId : game.blackId;
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId: recipientId, template: 'draw_offer', gameId: game.id },
        dedupKey: `dm:${recipientId}:g:${game.publicId}`,
        mergePayload: true,
      });
    }
    return loadGameDto(tx, updated, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

function requireOpponentOffer(game: GameRow, colour: Colour): void {
  if (game.drawOfferBy === null || game.drawOfferBy === colour) {
    throw new DomainError('forbidden', 'there is no offer to answer', { reason: 'no_offer' });
  }
}

export async function acceptDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    requireOpponentOffer(game, colour);
    const end: EndInput = { result: '1/2-1/2', endReason: 'draw_agreement' };
    return loadGameDto(tx, await finishGame(tx, game, end, now, colour), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

export async function declineDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    requireOpponentOffer(game, colour);
    const [updated] = await tx
      .update(games)
      .set({ drawOfferBy: null, drawOfferPly: null, version: sql`${games.version} + 1` })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    return loadGameDto(tx, updated, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** Spec §7.1: a claim succeeds only when the arbiter reports the current position claimable. */
export async function claimDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    const claims = computeClaims(game.fen, positionKeys(await listMoves(tx, game.id)));
    let end: EndInput;
    if (claims.threefold) end = { result: '1/2-1/2', endReason: 'threefold_claim' };
    else if (claims.fiftyMove) end = { result: '1/2-1/2', endReason: 'fifty_move_claim' };
    else throw new DomainError('forbidden', 'no draw can be claimed here', { reason: 'no_claim' });
    return loadGameDto(tx, await finishGame(tx, game, end, now, colour), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}
