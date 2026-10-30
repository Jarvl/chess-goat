import { describe, expect, it } from 'vitest';
import {
  INITIAL_FEN,
  applyMove,
  computeClaims,
  isValidFen,
  legalDests,
  parseUci,
  positionKey,
  sideToMove,
  timeoutOutcome,
} from '../../src/chess/arbiter';

const INITIAL_KEY = positionKey(INITIAL_FEN);
const PROMOTION_FEN = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
/** After 1.Nf3 Nf6 2.Ng1: Black's Ng8 recreates the initial position. */
const BEFORE_RETURN_FEN = 'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 2';

describe('applyMove', () => {
  it('plays a legal opening move and reports a continuing game', () => {
    expect(applyMove(INITIAL_FEN, [INITIAL_KEY], 'e2e4')).toEqual({
      legal: true,
      uci: 'e2e4',
      san: 'e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      capture: false,
      check: false,
      outcome: { kind: 'continue', claims: { threefold: false, fiftyMove: false } },
    });
  });

  it.each([
    ['an illegal destination', 'e2e5'],
    ["the opponent's piece", 'e7e5'],
    ['dash notation', 'e2-e4'],
    ['an off-board square', 'i9i9'],
    ['an empty string', ''],
  ])('rejects %s', (_label, uci) => {
    expect(applyMove(INITIAL_FEN, [INITIAL_KEY], uci)).toEqual({ legal: false });
  });

  it('normalises a promotion suffix on a non-promotion move', () => {
    const result = applyMove(INITIAL_FEN, [INITIAL_KEY], 'e2e4q');
    expect(result.legal && result.uci).toBe('e2e4');
  });

  it('requires the promotion piece', () => {
    expect(applyMove(PROMOTION_FEN, [], 'a7a8')).toEqual({ legal: false });
  });

  it('promotes and reports check', () => {
    const result = applyMove(PROMOTION_FEN, [], 'a7a8q');
    expect(result.legal && [result.uci, result.san, result.check]).toEqual([
      'a7a8q',
      'a8=Q+',
      true,
    ]);
  });

  it('reports a capture', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const result = applyMove(fen, [], 'e4d5');
    expect(result.legal && [result.san, result.capture]).toEqual(['exd5', true]);
  });

  it('detects checkmate for the mover', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
    const result = applyMove(fen, [], 'd8h4');
    expect(result.legal && [result.san, result.outcome]).toEqual([
      'Qh4#',
      { kind: 'checkmate', winner: 'black' },
    ]);
  });

  it('detects stalemate', () => {
    const result = applyMove('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1', [], 'c1c7');
    expect(result.legal && result.outcome).toEqual({ kind: 'draw', reason: 'stalemate' });
  });

  it('ends the game when a capture leaves insufficient material', () => {
    const result = applyMove('8/8/8/8/8/8/1r6/K6k w - - 0 1', [], 'a1b2');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'insufficient_material',
    });
  });

  it('ends the game on the fifth occurrence of a position', () => {
    const keys = [INITIAL_KEY, INITIAL_KEY, INITIAL_KEY, INITIAL_KEY];
    const result = applyMove(BEFORE_RETURN_FEN, keys, 'f6g8');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'fivefold_repetition',
    });
  });

  it('makes threefold repetition claimable, not automatic', () => {
    const result = applyMove(BEFORE_RETURN_FEN, [INITIAL_KEY, INITIAL_KEY], 'f6g8');
    expect(result.legal && result.outcome).toEqual({
      kind: 'continue',
      claims: { threefold: true, fiftyMove: false },
    });
  });

  it('does not count a position with an en passant right as a repeat of one without', () => {
    // 2…f5 lets White take en passant on f6. The knights then go out and back to the same
    // placement, where that capture is no longer possible: a different position (FIDE 9.2.3).
    let fen = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    const keys = [positionKey(fen)];
    const play = (uci: string) => {
      const result = applyMove(fen, keys, uci);
      if (!result.legal) throw new Error(`illegal ${uci} in ${fen}`);
      fen = result.fenAfter;
      keys.push(positionKey(fen));
      return result.outcome;
    };
    play('f7f5');
    expect(fen.split(' ')[3]).toBe('f6');
    const shuffle = () => ['g1f3', 'g8f6', 'f3g1', 'f6g8'].map(play).at(-1);
    const claims = (threefold: boolean) => ({
      kind: 'continue',
      claims: { threefold, fiftyMove: false },
    });
    expect(shuffle()).toEqual(claims(false));
    // The placement's third time on the board, but only the second without the en passant right.
    expect(shuffle()).toEqual(claims(false));
    expect(shuffle()).toEqual(claims(true));
  });

  it('ends the game at 75 moves without a capture or pawn move', () => {
    const result = applyMove('8/8/8/8/8/8/1R6/K6k w - - 149 100', [], 'b2b3');
    expect(result.legal && result.outcome).toEqual({
      kind: 'draw',
      reason: 'seventy_five_moves',
    });
  });

  it('makes the fifty-move rule claimable at halfmove 100', () => {
    const result = applyMove('8/8/8/8/8/8/1R6/K6k w - - 99 60', [], 'b2b3');
    expect(result.legal && result.outcome).toEqual({
      kind: 'continue',
      claims: { threefold: false, fiftyMove: true },
    });
  });

  it('lets checkmate win over the 75-move rule', () => {
    const result = applyMove('7k/8/6K1/8/8/8/8/1R6 w - - 149 100', [], 'b1b8');
    expect(result.legal && result.outcome).toEqual({ kind: 'checkmate', winner: 'white' });
  });
});

describe('computeClaims', () => {
  it('reports threefold when the current position appeared three times', () => {
    const keys = [INITIAL_KEY, 'other', INITIAL_KEY, 'another', INITIAL_KEY];
    expect(computeClaims(INITIAL_FEN, keys)).toEqual({ threefold: true, fiftyMove: false });
  });

  it('reports the fifty-move claim from the halfmove clock', () => {
    expect(computeClaims('8/8/8/8/8/8/1R6/K6k w - - 100 60', ['k'])).toEqual({
      threefold: false,
      fiftyMove: true,
    });
  });
});

describe('position helpers', () => {
  it('keys a position by placement, side, castling and en passant only', () => {
    expect(positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 12')).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    );
  });

  it('reads the side to move', () => {
    expect(sideToMove(INITIAL_FEN)).toBe('white');
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe('black');
  });

  it('records an en passant square only when a capture is legal', () => {
    const afterE5 = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    const withCapture = applyMove(afterE5, [], 'f7f5');
    expect(withCapture.legal && withCapture.fenAfter.split(' ')[3]).toBe('f6');
    const without = applyMove(INITIAL_FEN, [], 'e2e4');
    expect(without.legal && without.fenAfter.split(' ')[3]).toBe('-');
  });

  it('validates FEN strings', () => {
    expect(isValidFen(INITIAL_FEN)).toBe(true);
    expect(isValidFen('not a fen')).toBe(false);
  });

  it('parses UCI with an optional promotion piece', () => {
    expect(parseUci('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseUci('e2e4k')).toBeNull();
  });
});

describe('legalDests', () => {
  it('groups legal destinations by origin square', () => {
    const dests = legalDests(INITIAL_FEN);
    expect(dests.size).toBe(10);
    expect(dests.get('e2')).toEqual(['e3', 'e4']);
    expect(dests.get('g1')).toEqual(['f3', 'h3']);
    expect(dests.get('e1')).toBeUndefined();
  });

  it('lists a promotion square once', () => {
    expect(legalDests(PROMOTION_FEN).get('a7')).toEqual(['a8']);
  });
});

describe('timeoutOutcome', () => {
  it.each([
    ['a bare king', '4k3/8/8/8/8/8/8/4K3 b - - 0 1'],
    ['king and knight against a bare king', '4k3/8/8/8/8/8/8/4KN2 b - - 0 1'],
    ['king and bishop against a bare king', '4k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and bishop against a bishop on the same colour', '2b1k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
  ])('is a draw when the opponent cannot mate: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1/2-1/2', endReason: 'timeout' });
  });

  it.each([
    ['king and knight against a pawn', '4k3/4p3/8/8/8/8/8/4KN2 b - - 0 1'],
    ['king and bishop against a bishop on the other colour', '4kb2/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and rook', '4k3/8/8/8/8/8/8/4KR2 b - - 0 1'],
    ['two knights', '4k3/8/8/8/8/8/8/3NKN2 b - - 0 1'],
  ])('is a loss when the opponent could still mate: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1-0', endReason: 'timeout' });
  });

  it.each([
    ['king and bishop against a rook', 'r3k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and bishop against a queen', 'q3k3/8/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and knight against a queen', 'q3k3/8/8/8/8/8/8/4KN2 b - - 0 1'],
    ['two bishops on the same colour against a bare king', '4k3/8/8/8/8/8/8/3BKB2 b - - 0 1'],
  ])('is a draw when a helpmate is impossible: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1/2-1/2', endReason: 'timeout' });
  });

  it.each([
    ['king and bishop against a rook and a pawn', 'r3k3/4p3/8/8/8/8/8/4KB2 b - - 0 1'],
    ['king and knight against a rook', 'r3k3/8/8/8/8/8/8/4KN2 b - - 0 1'],
  ])('is a loss when a helpmate exists: %s', (_label, fen) => {
    expect(timeoutOutcome(fen, 'black')).toEqual({ result: '1-0', endReason: 'timeout' });
  });

  it('draws a white flag fall against a bare black king', () => {
    expect(timeoutOutcome('4k3/8/8/8/8/8/8/4KQ2 w - - 0 1', 'white')).toEqual({
      result: '1/2-1/2',
      endReason: 'timeout',
    });
  });

  it('scores a white flag fall against a black rook as a black win', () => {
    expect(timeoutOutcome('r3k3/8/8/8/8/8/8/4K3 w - - 0 1', 'white')).toEqual({
      result: '0-1',
      endReason: 'timeout',
    });
  });
});
