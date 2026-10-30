import { sideToMove, type Colour } from '@group-chess/shared';
import { PIECE_VIEWBOX, PIECES, type PieceCode } from './pieces';

export const IMAGE_SIZE = 1024;
const SQUARE = 100;
/** The Mini App's board (`--bl` / `--bd`) and the prototype's gold last-move tint. */
export const BOARD_LIGHT = '#f0ead2';
export const BOARD_DARK = '#7d9f6b';
const LAST_MOVE = 'rgba(224, 185, 74, 0.6)';
const FILES = 'abcdefgh';
const CHECK_GRADIENT =
  '<defs><radialGradient id="check" r="0.5">' +
  '<stop offset="0%" stop-color="#ff0000" stop-opacity="1"/>' +
  '<stop offset="25%" stop-color="#e70000" stop-opacity="1"/>' +
  '<stop offset="89%" stop-color="#a90000" stop-opacity="0"/>' +
  '<stop offset="100%" stop-color="#9e0000" stop-opacity="0"/>' +
  '</radialGradient></defs>';

export type BoardRenderInput = {
  fen: string;
  /** UCI of the move that produced the position, or null for the initial position. */
  lastMove: string | null;
  check: boolean;
  /** The colour at the bottom of the image. */
  orientation: Colour;
};

export type PlacedPiece = { file: number; rank: number; piece: PieceCode };

/** The placement field of a FEN as pieces with 0-based file (a = 0) and rank (first rank = 0). */
export function parsePlacement(fen: string): PlacedPiece[] {
  const rows = (fen.split(' ')[0] ?? '').split('/');
  const pieces: PlacedPiece[] = [];
  rows.forEach((row, index) => {
    let file = 0;
    for (const ch of row) {
      const skip = Number(ch);
      if (Number.isInteger(skip) && skip > 0) {
        file += skip;
        continue;
      }
      const colour = ch === ch.toUpperCase() ? 'w' : 'b';
      pieces.push({ file, rank: 7 - index, piece: `${colour}${ch.toUpperCase()}` as PieceCode });
      file += 1;
    }
  });
  return pieces;
}

function squareIndex(square: string): { file: number; rank: number } | null {
  const file = FILES.indexOf(square[0] ?? '');
  const rank = Number(square[1]) - 1;
  if (file < 0 || !(rank >= 0 && rank <= 7)) return null;
  return { file, rank };
}

/** Pixel origin of a square for the given orientation. */
function origin(file: number, rank: number, orientation: Colour): { x: number; y: number } {
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  return { x: column * SQUARE, y: row * SQUARE };
}

/** A square's top-left corner in the rendered image, in pixels. */
export function squarePixel(
  file: number,
  rank: number,
  orientation: Colour,
): { x: number; y: number } {
  const { x, y } = origin(file, rank, orientation);
  const scale = IMAGE_SIZE / (8 * SQUARE);
  return { x: x * scale, y: y * scale };
}

const rect = (cls: string | null, x: number, y: number, fill: string): string =>
  `<rect ${cls ? `class="${cls}" ` : ''}x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${fill}"/>`;

/** 0-based file (a = 0) and rank (first rank = 0); a1 is dark. */
function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 1;
}

/** Snapshot spec §1.1: green squares, last-move and check highlights, cburnett glyphs; no text. */
export function renderBoardSvg(input: BoardRenderInput): string {
  const pieces = parsePlacement(input.fen);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${8 * SQUARE} ${8 * SQUARE}" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}">`,
    CHECK_GRADIENT,
  ];
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const { x, y } = origin(file, rank, input.orientation);
      parts.push(rect(null, x, y, isLightSquare(file, rank) ? BOARD_LIGHT : BOARD_DARK));
    }
  }
  if (input.lastMove) {
    for (const square of [input.lastMove.slice(0, 2), input.lastMove.slice(2, 4)]) {
      const at = squareIndex(square);
      if (!at) continue;
      const { x, y } = origin(at.file, at.rank, input.orientation);
      parts.push(rect('last-move', x, y, LAST_MOVE));
    }
  }
  if (input.check) {
    const kingCode: PieceCode = sideToMove(input.fen) === 'white' ? 'wK' : 'bK';
    const king = pieces.find((placed) => placed.piece === kingCode);
    if (king) {
      const { x, y } = origin(king.file, king.rank, input.orientation);
      parts.push(rect('check', x, y, 'url(#check)'));
    }
  }
  const scale = (SQUARE / PIECE_VIEWBOX).toFixed(4);
  for (const placed of pieces) {
    const { x, y } = origin(placed.file, placed.rank, input.orientation);
    parts.push(
      `<g class="piece ${placed.piece}" transform="translate(${x} ${y}) scale(${scale})">${PIECES[placed.piece]}</g>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}
