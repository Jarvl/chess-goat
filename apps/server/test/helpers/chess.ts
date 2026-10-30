import { applyMove, positionKey, type PremoveNode } from '@group-chess/shared';
import type { StoredMove } from '../../src/flair/patterns';

/** White to move, with a pawn on e7 one step from promoting on e8 (flair spec §7). */
export const PROMOTION_FEN = '3k4/4P3/8/8/8/8/8/4K3 w - - 0 1';

/** White, with only king and queen, mates by `a1a8` (flair spec §1.8). */
export const QUEEN_MATE_FEN = '7k/8/6K1/8/8/8/8/Q7 w - - 0 1';

/** The same mate with a rook, `a1a8`. */
export const ROOK_MATE_FEN = '7k/8/6K1/8/8/8/8/R7 w - - 0 1';

/** The queen mate by `b1b8`, with a white pawn still on a2. */
export const QUEEN_AND_PAWN_MATE_FEN = '7k/8/6K1/8/8/8/P7/1Q6 w - - 0 1';

/** White mates by capturing on h8 and promoting, `g7h8q` (`gxh8=Q#`). */
export const CAPTURE_PROMOTION_MATE_FEN = 'k6r/6P1/1K6/8/8/8/8/8 w - - 0 1';

/** White, with only king and two bishops, mates by `c2e4`. */
export const BISHOPS_MATE_FEN = 'k7/8/1K1B4/8/8/8/2B5/8 w - - 0 1';

/** The bishops' mate by `c2e4`, with a white pawn still on h2. */
export const BISHOPS_AND_PAWN_MATE_FEN = 'k7/8/1K1B4/8/8/8/2B4P/8 w - - 0 1';

/**
 * Games for the flair move-pattern tests (flair spec §1.8, §7), in coordinate notation from the
 * initial position. Each line was replayed with the shared arbiter, and the mates are mates at the
 * plies noted.
 */
export const LINES = {
  enPassant: ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'],
  ordinarySixthRankCapture: ['e2e4', 'd7d5', 'e4d5', 'e7e6', 'd5e6'],
  blackEnPassant: ['a2a3', 'e7e5', 'a3a4', 'e5e4', 'd2d4', 'e4d3'],
  bothCastleQueenside: [
    'd2d4',
    'd7d5',
    'c1f4',
    'c8f5',
    'b1c3',
    'b8c6',
    'd1d2',
    'd8d7',
    'e1c1',
    'e8c8',
  ],
  whiteCastlesKingside: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1'],
  scholarsMateQh5: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'], // Qxf7# at ply 7
  scholarsMateQf3: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1f3', 'd7d6', 'f3f7'], // Qxf7# at ply 7
  blackScholarsMate: ['a2a3', 'e7e5', 'h2h3', 'f8c5', 'b2b3', 'd8h4', 'c2c3', 'h4f2'], // Qxf2# at ply 8
  mateOnMoveFive: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'a7a6', 'b1c3', 'g8f6', 'h5f7'], // ply 9
  checkNotMate: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7'], // Qxf7+
  // Black mates at ply 8 after White took a pawn with Nxd5 at ply 3.
  mateAfterLosingAPawn: ['b1c3', 'd7d5', 'c3d5', 'e7e5', 'f2f3', 'a7a6', 'g2g4', 'd8h4'],
  foolsMate: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], // Qh4# at ply 4
  // Black captures en passant with dxc3 at ply 6, then mates with Qh4# at ply 10.
  blackEnPassantThenMate: [
    'f2f3',
    'd7d5',
    'a2a3',
    'd5d4',
    'c2c4',
    'd4c3',
    'g2g4',
    'e7e6',
    'a3a4',
    'd8h4',
  ],
  bongcloud: ['e2e4', 'e7e5', 'e1e2'],
  blackBongcloud: ['e2e4', 'e7e5', 'g1f3', 'e8e7'],
  kingWalksOnMoveThree: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'e1e2'],
  kingWalksAfterD4: ['d2d4', 'e7e5', 'e1d2'],
} as const;

/**
 * Replays `ucis` from `start` with the shared arbiter, carrying the position keys as the server
 * does, and returns the rows the `moves` table would hold. Plies start at 1, so White moves at odd
 * plies when `start` has White to move, as in every stored game. Throws on an illegal move.
 */
export function play(start: string, ...ucis: string[]): StoredMove[] {
  const keys = [positionKey(start)];
  let fen = start;
  return ucis.map((uci, index) => {
    const result = applyMove(fen, keys, uci);
    if (!result.legal) throw new Error(`illegal move ${uci} at ply ${index + 1} in ${fen}`);
    fen = result.fenAfter;
    keys.push(positionKey(fen));
    return { ply: index + 1, uci: result.uci, san: result.san, fenAfter: result.fenAfter };
  });
}

/** A knight shuffle `pairs` deep from the initial position, as a premove line, and its last list. */
export function deepLine(pairs: number): { root: PremoveNode[]; bottom: PremoveNode[] } {
  const root: PremoveNode[] = [];
  let bottom = root;
  for (let index = 0; index < pairs; index += 1) {
    const [move, reply] = index % 2 === 0 ? ['g1f3', 'g8f6'] : ['f3g1', 'f6g8'];
    const entry: PremoveNode = { move: move!, reply: reply!, children: [] };
    bottom.push(entry);
    bottom = entry.children;
  }
  return { root, bottom };
}
