import { describe, expect, it } from 'vitest';
import { randomLegalMove } from '../../src/jobs/handlers/engine';

describe('randomLegalMove', () => {
  // Black to move, exactly one legal move for the whole side: Ra7-a8 (verified with chess.js).
  // The rook's own king (b8) has no legal square — a8 and c8 are covered by the knight on b6,
  // c7 by the knight on e6, and a7/b7 are occupied by black's own rook and pawn — and the pawns
  // on a6/b7 are themselves fully blocked. This pins the promotion-suffix decision without
  // touching `Math.random`: with only one (from, targets) entry and one target, the random
  // picks are forced regardless of the RNG.
  const FORCED_ROOK_TO_RANK_8 = '1k6/rp6/pN2N3/K7/8/8/8/8 b - - 0 1';

  it('never tags a non-pawn move with a promotion suffix, even from rank 2/7 to rank 1/8', () => {
    // Under the old from-rank/to-rank heuristic (any piece from rank 2/7 to rank 1/8 counts as
    // "promoting"), this exact move — a rook going a7 to a8 — would have been sent as `a7a8q`.
    expect(randomLegalMove(FORCED_ROOK_TO_RANK_8)).toBe('a7a8');
  });

  it('still tags a genuine pawn promotion', () => {
    // White to move: a pawn one step from promoting is the only piece with a legal move — the
    // king's three escape squares (a2, b1, b2) are all covered by the black queen on c2, without
    // the queen itself attacking a1 (verified with chess.js), so the pawn is forced.
    const fen = '7k/P7/8/8/8/8/2q5/K7 w - - 0 1';
    expect(randomLegalMove(fen)).toBe('a7a8q');
  });

  it('returns null when there are no legal moves', () => {
    // A genuine stalemate (verified with chess.js: 0 moves, not in check).
    const fen = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
    expect(randomLegalMove(fen)).toBeNull();
  });
});
