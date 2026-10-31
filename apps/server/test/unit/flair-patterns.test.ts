import { INITIAL_FEN, type Colour } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { gaveMate, madePattern, type StoredMove } from '../../src/flair/patterns';
import {
  BISHOPS_AND_PAWN_MATE_FEN,
  BISHOPS_MATE_FEN,
  CAPTURE_PROMOTION_MATE_FEN,
  LINES,
  play,
  PROMOTION_FEN,
  QUEEN_AND_PAWN_MATE_FEN,
  QUEEN_MATE_FEN,
  ROOK_MATE_FEN,
} from '../helpers/chess';

const from = (line: readonly string[]) => play(INITIAL_FEN, ...line);

describe('en_passant', () => {
  it('sees a capture en passant, for the side that made it', () => {
    expect(madePattern('en_passant', from(LINES.enPassant), 'white')).toBe(true);
    expect(madePattern('en_passant', from(LINES.enPassant), 'black')).toBe(false);
    expect(madePattern('en_passant', from(LINES.blackEnPassant), 'black')).toBe(true);
  });
  it('ignores an ordinary pawn capture onto the sixth rank', () =>
    expect(madePattern('en_passant', from(LINES.ordinarySixthRankCapture), 'white')).toBe(false));
});

describe('castle_queenside', () => {
  it('sees O-O-O for each side that played it, and not O-O', () => {
    expect(madePattern('castle_queenside', from(LINES.bothCastleQueenside), 'white')).toBe(true);
    expect(madePattern('castle_queenside', from(LINES.bothCastleQueenside), 'black')).toBe(true);
    expect(madePattern('castle_queenside', from(LINES.whiteCastlesKingside), 'white')).toBe(false);
    // By ply 9 only White has castled.
    expect(
      madePattern('castle_queenside', from(LINES.bothCastleQueenside.slice(0, 9)), 'black'),
    ).toBe(false);
  });
});

describe('promotion', () => {
  it('sees a promotion to any piece, for the side that made it', () => {
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8q'), 'white')).toBe(true);
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8n'), 'white')).toBe(true);
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8q'), 'black')).toBe(false);
    // A game with no promotion.
    expect(madePattern('promotion', from(LINES.enPassant), 'white')).toBe(false);
  });
});

describe('scholars_mate', () => {
  it('sees the queen mate on f7 by White’s fourth move, through h5 or f3', () => {
    for (const line of [LINES.scholarsMateQh5, LINES.scholarsMateQf3]) {
      expect(madePattern('scholars_mate', from(line), 'white')).toBe(true);
      expect(madePattern('scholars_mate', from(line), 'black')).toBe(false);
    }
  });
  it('sees Black’s mirror on f2', () =>
    expect(madePattern('scholars_mate', from(LINES.blackScholarsMate), 'black')).toBe(true));
  it('ignores the same mate on move five and a Qxf7+ that is not mate', () => {
    expect(madePattern('scholars_mate', from(LINES.mateOnMoveFive), 'white')).toBe(false);
    expect(madePattern('scholars_mate', from(LINES.checkNotMate), 'white')).toBe(false);
  });
});

describe('underpromotion', () => {
  it('sees a promotion to a knight, bishop or rook, and not to a queen', () => {
    for (const piece of ['n', 'b', 'r'])
      expect(madePattern('underpromotion', play(PROMOTION_FEN, `e7e8${piece}`), 'white')).toBe(
        true,
      );
    expect(madePattern('underpromotion', play(PROMOTION_FEN, 'e7e8q'), 'white')).toBe(false);
    expect(madePattern('underpromotion', play(PROMOTION_FEN, 'e7e8n'), 'black')).toBe(false);
  });
});

describe('queen_mate', () => {
  it('sees a mate by a side left with only its king and queen', () => {
    expect(madePattern('queen_mate', play(QUEEN_MATE_FEN, 'a1a8'), 'white')).toBe(true);
    expect(madePattern('queen_mate', play(QUEEN_MATE_FEN, 'a1a8'), 'black')).toBe(false);
  });
  it('ignores a mate with anything else still on the board, or with no queen', () => {
    expect(madePattern('queen_mate', play(QUEEN_AND_PAWN_MATE_FEN, 'b1b8'), 'white')).toBe(false);
    expect(madePattern('queen_mate', play(ROOK_MATE_FEN, 'a1a8'), 'white')).toBe(false);
    // A queen move that is not mate.
    expect(madePattern('queen_mate', play(QUEEN_MATE_FEN, 'a1a7'), 'white')).toBe(false);
  });
});

describe('bishops_mate', () => {
  it('sees a mate by a side left with only its king and two bishops', () => {
    expect(madePattern('bishops_mate', play(BISHOPS_MATE_FEN, 'c2e4'), 'white')).toBe(true);
    expect(madePattern('bishops_mate', play(BISHOPS_MATE_FEN, 'c2e4'), 'black')).toBe(false);
  });
  it('ignores a mate with anything else still on the board', () => {
    expect(madePattern('bishops_mate', play(BISHOPS_AND_PAWN_MATE_FEN, 'c2e4'), 'white')).toBe(
      false,
    );
    expect(madePattern('bishops_mate', play(QUEEN_MATE_FEN, 'a1a8'), 'white')).toBe(false);
  });
});

describe('flawless_mate', () => {
  it('sees a mate by a side that never had a man captured', () => {
    expect(madePattern('flawless_mate', from(LINES.scholarsMateQh5), 'white')).toBe(true);
    expect(madePattern('flawless_mate', from(LINES.scholarsMateQh5), 'black')).toBe(false);
  });
  it('ignores a mate after the opponent took so much as a pawn, and a game without mate', () => {
    expect(madePattern('flawless_mate', from(LINES.mateAfterLosingAPawn), 'black')).toBe(false);
    expect(madePattern('flawless_mate', from(LINES.checkNotMate), 'white')).toBe(false);
  });
});

describe('bongcloud', () => {
  it('sees the e-pawn then the king on the side’s first two moves', () => {
    expect(madePattern('bongcloud', from(LINES.bongcloud), 'white')).toBe(true);
    expect(madePattern('bongcloud', from(LINES.bongcloud), 'black')).toBe(false);
    expect(madePattern('bongcloud', from(LINES.blackBongcloud), 'black')).toBe(true);
    expect(madePattern('bongcloud', from(LINES.blackBongcloud), 'white')).toBe(false);
  });
  it('ignores a king walk on a later move or after another first move', () => {
    expect(madePattern('bongcloud', from(LINES.kingWalksOnMoveThree), 'white')).toBe(false);
    expect(madePattern('bongcloud', from(LINES.kingWalksAfterD4), 'white')).toBe(false);
  });
});

describe('marathon', () => {
  const plies = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ply: i + 1, uci: 'a1a1', san: 'Ka1', fenAfter: '' }));
  it('sees a game past move 100, for either side', () => {
    expect(madePattern('marathon', plies(200), 'white')).toBe(false);
    expect(madePattern('marathon', plies(201), 'white')).toBe(true);
    expect(madePattern('marathon', plies(201), 'black')).toBe(true);
  });
});

describe('pacifist_mate', () => {
  it('sees a mate by a side that never captured, whatever the opponent took', () => {
    expect(madePattern('pacifist_mate', from(LINES.foolsMate), 'black')).toBe(true);
    // White captured on d5 at ply 3; Black still never did.
    expect(madePattern('pacifist_mate', from(LINES.mateAfterLosingAPawn), 'black')).toBe(true);
    // The mated side made no capture either, but gave no mate.
    expect(madePattern('pacifist_mate', from(LINES.foolsMate), 'white')).toBe(false);
  });
  it('ignores a mate after any capture of the side’s own', () => {
    const own: [StoredMove[], Colour][] = [
      [from(LINES.scholarsMateQh5), 'white'], // Qxf7#
      [play(CAPTURE_PROMOTION_MATE_FEN, 'g7h8q'), 'white'], // gxh8=Q#
      [from(LINES.blackEnPassantThenMate), 'black'], // dxc3 en passant, then Qh4#
    ];
    for (const [moves, side] of own) {
      expect(gaveMate(moves, side)).toBe(true);
      expect(madePattern('pacifist_mate', moves, side)).toBe(false);
    }
  });
  it('ignores a game without a mate', () =>
    expect(madePattern('pacifist_mate', from(LINES.bongcloud), 'white')).toBe(false));
});
