import { buildPgn, t, type EngineLevel, type TimePerMove } from '@chess-goat/shared';
import type { DbOrTx } from '../db/client';
import type { GameRow, UserRow } from '../db/schema';
import { listMoves } from './games';
import { requireGroup } from './groups';
import { displayName, requireUser } from './users';
import { isEngine } from './playerKind';

/**
 * The engine's name carries the level where it is meaningful (`Stockfish (Club)`). An
 * engine game deliberately gets no Lichess URL, so this PGN is the only permanent record
 * of it and must say what was played. The label is the same user-facing copy the level list shows,
 * which keeps the "no rating numbers in user-facing output" rule true of the PGN too.
 */
function playerName(user: UserRow, engineLevel: string | null): string {
  const name = displayName(user);
  if (!isEngine(user) || engineLevel === null) return name;
  return `${name} (${t(`app.level.${engineLevel as EngineLevel}`)})`;
}

/** Headers and movetext from the moves table. */
export async function buildGamePgn(tx: DbOrTx, game: GameRow): Promise<string> {
  const [group, white, black, moves] = await Promise.all([
    requireGroup(tx, game.groupId),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    listMoves(tx, game.id),
  ]);
  return buildPgn(
    {
      site: group.title,
      date: game.startedAt,
      white: playerName(white, game.engineLevel),
      black: playerName(black, game.engineLevel),
      result: game.result ?? '*',
      whiteElo: game.rated ? (game.whiteRatingBefore ?? null) : null,
      blackElo: game.rated ? (game.blackRatingBefore ?? null) : null,
      timePerMove: game.timePerMove as TimePerMove,
      endReason: game.endReason,
    },
    moves.map((move) => move.san),
  );
}
