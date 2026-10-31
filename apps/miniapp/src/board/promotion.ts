import type { Colour } from '@chess-goat/shared';
import { Chess } from 'chess.js';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

const FILES = 'abcdefgh';

/** A pawn moving to the last rank must name its piece (spec §7.2: promotion is mandatory). */
export function isPromotion(fen: string, orig: string, dest: string): boolean {
  let piece: { type: string; color: string } | undefined;
  try {
    piece = new Chess(fen).get(orig as 'a1') ?? undefined;
  } catch {
    return false;
  }
  if (!piece || piece.type !== 'p') return false;
  const rank = dest[1];
  return (piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1');
}

export function promotionPieces(): PromotionPiece[] {
  return ['q', 'r', 'b', 'n'];
}

/** Where the chooser sits: over the target square, growing towards the middle of the board. */
export function promotionOverlayStyle(
  dest: string,
  orientation: Colour,
): { left: string; top: string } {
  const file = FILES.indexOf(dest[0] ?? 'a');
  const rank = Number(dest[1] ?? '1');
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  return { left: `${column * 12.5}%`, top: `${row * 12.5}%` };
}
