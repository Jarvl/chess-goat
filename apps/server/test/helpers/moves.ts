import type { GameDto } from '@chess-goat/shared';
import type { Deps } from '../../src/domain/deps';
import { loadGameDto, playMove } from '../../src/domain/games';

/**
 * A move as the Mini App sends it (UCI, an optional base64url premove tree), answered with the
 * game as the API shows it: what `POST /games/:id/moves` does, without the HTTP.
 */
export async function playMoveDto(
  deps: Deps,
  input: {
    gameId: string;
    userId: number;
    uci: string;
    expectedPly: number;
    clientMoveId?: string;
    premoveTree?: string;
  },
): Promise<GameDto> {
  const { game } = await playMove(deps, {
    gameId: input.gameId,
    userId: input.userId,
    move: input.uci,
    expectedPly: input.expectedPly,
    clientMoveId: input.clientMoveId,
    premoves: { tree: input.premoveTree ?? '', ifIllegal: 'reject' },
  });
  return loadGameDto(deps.db, game, input.userId);
}
