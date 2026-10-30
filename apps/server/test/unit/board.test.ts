import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { parsePlacement, renderBoardSvg } from '../../src/images/board';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
/** Fool's mate: the white king on e1 is in check from h4. */
const CHECK = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const white = { lastMove: null, check: false, orientation: 'white' as const };

describe('parsePlacement', () => {
  it('reads the initial position into files and ranks', () => {
    const pieces = parsePlacement(INITIAL_FEN);
    expect(pieces).toHaveLength(32);
    expect(pieces).toContainEqual({ file: 4, rank: 0, piece: 'wK' });
    expect(pieces).toContainEqual({ file: 3, rank: 7, piece: 'bQ' });
  });
});

describe('renderBoardSvg', () => {
  it('draws 64 squares with a dark a1 and 32 pieces for the initial position', () => {
    const svg = renderBoardSvg({ fen: INITIAL_FEN, ...white });
    expect(svg.match(/<rect /g)).toHaveLength(64);
    expect(svg).toContain('<rect x="0" y="700" width="100" height="100" fill="#7d9f6b"/>');
    expect(svg.match(/<g class="piece /g)).toHaveLength(32);
    expect(svg).toContain('class="piece wK" transform="translate(400 700)');
  });

  it('highlights the last move squares and the checked king', () => {
    const svg = renderBoardSvg({ fen: CHECK, lastMove: 'd8h4', check: true, orientation: 'white' });
    expect(svg).toContain('<rect class="last-move" x="300" y="0"');
    expect(svg).toContain('<rect class="last-move" x="700" y="400"');
    expect(svg).toContain(
      '<rect class="check" x="400" y="700" width="100" height="100" fill="url(#check)"/>',
    );
    expect(svg).toContain('<radialGradient id="check"');
    expect(svg).toContain('fill="rgba(224, 185, 74, 0.6)"');
  });

  it('puts the sharer colour at the bottom', () => {
    const svg = renderBoardSvg({
      fen: AFTER_E4,
      lastMove: 'e2e4',
      check: false,
      orientation: 'black',
    });
    expect(svg).toContain('class="piece wK" transform="translate(300 0)');
    expect(svg).toContain('<rect class="last-move" x="300" y="300"');
  });
});
