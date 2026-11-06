import { decodePremoveBytes, type Colour, type PremoveNode } from '@chess-goat/shared';
import { Chess } from 'chess.js';
import type { GameRow, MoveRow, UserRow } from '../db/schema';
import { colourOf, storedPremoveTree } from '../domain/gameDto';
import { isOwnedBot, displayName } from '../domain/users';

export type GameView = {
  gameId: string;
  group: { groupId: string; title: string };
  you: Colour;
  opponent: { name: string; isBot: boolean };
  status: GameRow['status'];
  result: GameRow['result'];
  endReason: GameRow['endReason'];
  ply: number;
  toMove: Colour;
  yourTurn: boolean;
  fen: string;
  board: string;
  moves: string[];
  legalMoves: { san: string; uci: string }[];
  timePerMove: number | null;
  deadlineAt: string | null;
  drawOffer: 'none' | 'from_you' | 'from_opponent';
  rated: boolean;
  premoveTree: PremoveNode[];
  pgn?: string;
};

export type RenderInput = {
  game: GameRow;
  moves: readonly Pick<MoveRow, 'san'>[];
  group: { publicId: string; title: string };
  white: UserRow;
  black: UserRow;
};

/** The board as text from `orientation`'s side: rank labels down the left, files along the foot. */
export function asciiBoard(fen: string, orientation: Colour): string {
  const board = new Chess(fen).board();
  const ranks = orientation === 'white' ? board : [...board].reverse();
  const lines = ranks.map((rank, i) => {
    const row = orientation === 'white' ? rank : [...rank].reverse();
    const label = orientation === 'white' ? 8 - i : i + 1;
    const cells = row.map((sq) =>
      sq === null ? '.' : sq.color === 'w' ? sq.type.toUpperCase() : sq.type,
    );
    return `${label} ${cells.join(' ')}`;
  });
  const files = orientation === 'white' ? 'abcdefgh' : 'hgfedcba';
  lines.push(`  ${[...files].join(' ')}`);
  return lines.join('\n');
}

/** The game as `viewerBotId` sees it. The caller guarantees that bot plays in the game. */
export function renderGame(input: RenderInput, viewerBotId: number): GameView {
  const { game } = input;
  const you = colourOf(game, viewerBotId);
  if (you === null) throw new Error('renderGame: the viewer is not a player');
  const chess = new Chess(game.fen);
  const toMove: Colour = chess.turn() === 'w' ? 'white' : 'black';
  const active = game.status === 'active';
  const yourTurn = active && toMove === you;
  const opponent = you === 'white' ? input.black : input.white;
  return {
    gameId: game.publicId,
    group: { groupId: input.group.publicId, title: input.group.title },
    you,
    opponent: { name: displayName(opponent), isBot: isOwnedBot(opponent) },
    status: game.status,
    result: game.result,
    endReason: game.endReason,
    ply: game.plyCount,
    toMove,
    yourTurn,
    fen: game.fen,
    board: asciiBoard(game.fen, you),
    moves: input.moves.map((move) => move.san),
    legalMoves: yourTurn
      ? chess.moves({ verbose: true }).map((move) => ({ san: move.san, uci: move.lan }))
      : [],
    timePerMove: game.timePerMove,
    deadlineAt: active && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    drawOffer:
      active && game.drawOfferBy !== null
        ? game.drawOfferBy === you
          ? 'from_you'
          : 'from_opponent'
        : 'none',
    rated: game.rated,
    // The stored tree belongs to the side not to move, and only counts at the ply it was stored.
    premoveTree: active && toMove !== you ? decodePremoveBytes(storedPremoveTree(game)) : [],
  };
}
