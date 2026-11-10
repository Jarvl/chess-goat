import { Chess, type Move, type Square } from 'chess.js';
import { opposite, type Colour, type GameResult } from '../protocol/enums';

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type Claims = { threefold: boolean; fiftyMove: boolean };

export type AutomaticDrawReason =
  'stalemate' | 'insufficient_material' | 'fivefold_repetition' | 'seventy_five_moves';

export type Outcome =
  | { kind: 'continue'; claims: Claims }
  | { kind: 'checkmate'; winner: Colour }
  | { kind: 'draw'; reason: AutomaticDrawReason };

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export type ParsedUci = { from: Square; to: Square; promotion?: PromotionPiece };

export type ApplyMoveResult =
  | { legal: false }
  | {
      legal: true;
      /** Normalised coordinate notation, e.g. `e2e4` or `a7a8q`; the value to store. */
      uci: string;
      san: string;
      fenAfter: string;
      capture: boolean;
      check: boolean;
      outcome: Outcome;
    };

const UCI_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function parseUci(uci: string): ParsedUci | null {
  const match = UCI_PATTERN.exec(uci);
  if (!match) return null;
  const from = match[1] as Square;
  const to = match[2] as Square;
  const promotion = match[3] as PromotionPiece | undefined;
  return promotion ? { from, to, promotion } : { from, to };
}

/** The first four FEN fields identify a position for repetition purposes. */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function sideToMove(fen: string): Colour {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function halfmoveClock(fen: string): number {
  return Number(fen.split(' ')[4] ?? '0');
}

export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

function countKey(keys: readonly string[], key: string): number {
  let count = 0;
  for (const candidate of keys) {
    if (candidate === key) count += 1;
  }
  return count;
}

/** Claims available in the position `fen`, whose key is the last entry of `keysSoFar`. */
export function computeClaims(fen: string, keysSoFar: readonly string[]): Claims {
  return {
    threefold: countKey(keysSoFar, positionKey(fen)) >= 3,
    fiftyMove: halfmoveClock(fen) >= 100,
  };
}

/**
 * Applies `uci` to `fen`. `keysSoFar` holds the position key of every position reached so far,
 * the initial position included, so repetitions of the new position can be counted.
 * Threefold repetition and the fifty-move rule are reported as claims, never as an outcome.
 */
export function applyMove(fen: string, keysSoFar: readonly string[], uci: string): ApplyMoveResult {
  const parsed = parseUci(uci);
  if (!parsed) return { legal: false };
  const chess = new Chess(fen);
  let move: Move;
  try {
    move = chess.move(parsed);
  } catch {
    return { legal: false };
  }
  const fenAfter = chess.fen();
  const repetitions = countKey(keysSoFar, positionKey(fenAfter)) + 1;
  const halfmoves = halfmoveClock(fenAfter);

  let outcome: Outcome;
  if (chess.isCheckmate()) {
    outcome = { kind: 'checkmate', winner: sideToMove(fen) };
  } else if (chess.isStalemate()) {
    outcome = { kind: 'draw', reason: 'stalemate' };
  } else if (chess.isInsufficientMaterial()) {
    outcome = { kind: 'draw', reason: 'insufficient_material' };
  } else if (repetitions >= 5) {
    outcome = { kind: 'draw', reason: 'fivefold_repetition' };
  } else if (halfmoves >= 150) {
    outcome = { kind: 'draw', reason: 'seventy_five_moves' };
  } else {
    outcome = {
      kind: 'continue',
      claims: { threefold: repetitions >= 3, fiftyMove: halfmoves >= 100 },
    };
  }

  return {
    legal: true,
    uci: move.lan,
    san: move.san,
    fenAfter,
    capture: move.captured !== undefined,
    check: chess.inCheck(),
    outcome,
  };
}

/** Legal destinations per origin square, in the shape chessground's `movable.dests` wants. */
export function legalDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  for (const move of new Chess(fen).moves({ verbose: true })) {
    const targets = dests.get(move.from) ?? [];
    if (!targets.includes(move.to)) targets.push(move.to);
    dests.set(move.from, targets);
  }
  return dests;
}

type Material = { nonKing: string[]; bishopSquares: Set<'light' | 'dark'> };

function materialOf(fen: string, colour: Colour): Material {
  const placement = fen.split(' ')[0] ?? '';
  const material: Material = { nonKing: [], bishopSquares: new Set() };
  let rank = 7;
  let file = 0;
  for (const symbol of placement) {
    if (symbol === '/') {
      rank -= 1;
      file = 0;
      continue;
    }
    if (symbol >= '1' && symbol <= '8') {
      file += Number(symbol);
      continue;
    }
    const isWhite = symbol === symbol.toUpperCase();
    const piece = symbol.toLowerCase();
    if ((colour === 'white') === isWhite && piece !== 'k') {
      material.nonKing.push(piece);
      if (piece === 'b') material.bishopSquares.add((rank + file) % 2 === 0 ? 'dark' : 'light');
    }
    file += 1;
  }
  return material;
}

/**
 * FIDE Article 6.9: the player whose flag fell loses, unless the opponent could not checkmate by
 * any series of legal moves, in which case the game is drawn.
 */
export function timeoutOutcome(
  fen: string,
  flagged: Colour,
): { result: GameResult; endReason: 'timeout' } {
  const winner = opposite(flagged);
  const winning = materialOf(fen, winner);
  const losing = materialOf(fen, flagged);
  const winnerBishopsOnly =
    winning.nonKing.length > 0 && winning.nonKing.every((piece) => piece === 'b');
  let canMate: boolean;
  if (winning.nonKing.length === 0) {
    canMate = false;
  } else if (winning.nonKing.length === 1 && winning.nonKing[0] === 'n') {
    // A lone knight can be helped to mate by any defending piece except a queen.
    canMate = losing.nonKing.some((piece) => piece !== 'q');
  } else if (winnerBishopsOnly) {
    // Bishops on one square colour mate only with an opposite-coloured bishop, a knight or a
    // pawn on the board; a defending rook or queen always interposes.
    const colours = new Set([...winning.bishopSquares, ...losing.bishopSquares]);
    canMate = colours.size === 2 || losing.nonKing.some((piece) => piece === 'n' || piece === 'p');
  } else {
    canMate = true;
  }
  if (!canMate) return { result: '1/2-1/2', endReason: 'timeout' };
  return { result: winner === 'white' ? '1-0' : '0-1', endReason: 'timeout' };
}
