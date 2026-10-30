import { describe, expect, it } from 'vitest';
import { boardConfig, highlightSquares } from '../src/board/adapter';
import { isPromotion, promotionOverlayStyle, promotionPieces } from '../src/board/promotion';
import { AFTER_E4 } from './support/gameFixtures';

describe('boardConfig', () => {
  it('maps a position and the movable set onto chessground options', () => {
    const dests = new Map([['e2', ['e3', 'e4']]]);
    const config = boardConfig(
      {
        fen: AFTER_E4,
        lastMove: ['e2', 'e4'],
        check: false,
        orientation: 'black',
        turnColour: 'black',
      },
      { colour: 'black', dests },
      false,
      () => undefined,
    );
    expect(config).toMatchObject({
      fen: AFTER_E4,
      orientation: 'black',
      turnColor: 'black',
      lastMove: ['e2', 'e4'],
      check: false,
      viewOnly: false,
      coordinates: true,
      movable: { free: false, color: 'black', showDests: true },
      premovable: { enabled: false },
      drawable: { enabled: false },
      selectable: { enabled: true },
      blockTouchScroll: true,
    });
    expect(config.movable?.dests?.get('e2')).toEqual(['e3', 'e4']);
  });

  it('lifts nothing for spectators and out of turn', () => {
    const config = boardConfig(
      { fen: AFTER_E4, lastMove: null, check: true, orientation: 'white', turnColour: 'black' },
      { colour: 'none', dests: new Map() },
      true,
      () => undefined,
    );
    expect(config.movable?.color).toBeUndefined();
    expect(config.viewOnly).toBe(true);
    expect(config.check).toBe('black');
  });

  it('marks the checked king, not the turn colour, when they differ (premove mode)', () => {
    // White's knight just checked from a7; White is premoving, so the turn colour is White.
    const fen = '2kr3r/Npp1n1bp/2q1p1p1/3p1p2/3P4/3BP3/PPP2PPP/R1BQ1RK1 b - - 1 16';
    const config = boardConfig(
      { fen, lastMove: ['b5', 'a7'], check: true, orientation: 'white', turnColour: 'white' },
      { colour: 'white', dests: new Map() },
      false,
      () => undefined,
    );
    expect(config.turnColor).toBe('white');
    expect(config.check).toBe('black');
  });
});

describe('promotion', () => {
  const WHITE_PAWN_E7 = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const BLACK_PAWN_D2 = '4k3/8/8/8/8/8/3p4/4K3 b - - 0 1';

  it('recognises a pawn reaching the last rank for either colour', () => {
    expect(isPromotion(WHITE_PAWN_E7, 'e7', 'e8')).toBe(true);
    expect(isPromotion(BLACK_PAWN_D2, 'd2', 'd1')).toBe(true);
    expect(isPromotion(AFTER_E4, 'e2', 'e4')).toBe(false);
    expect(isPromotion(WHITE_PAWN_E7, 'e1', 'e2')).toBe(false);
  });

  it('lists queen, rook, bishop and knight and positions the chooser over the target square', () => {
    expect(promotionPieces()).toEqual(['q', 'r', 'b', 'n']);
    expect(promotionOverlayStyle('e8', 'white')).toEqual({ left: '50%', top: '0%' });
    expect(promotionOverlayStyle('e8', 'black')).toEqual({ left: '37.5%', top: '87.5%' });
    expect(promotionOverlayStyle('d1', 'black')).toEqual({ left: '50%', top: '0%' });
  });
});

describe('premove highlights and taps', () => {
  const position = {
    fen: AFTER_E4,
    lastMove: null,
    check: false,
    orientation: 'white' as const,
    turnColour: 'white' as const,
  };
  const movable = { colour: 'white' as const, dests: new Map<string, string[]>() };

  it("marks the viewed premove's squares with the premove class", () => {
    expect(highlightSquares(['g1', 'h3'])).toEqual(
      new Map([
        ['g1', 'premove-sq'],
        ['h3', 'premove-sq'],
      ]),
    );
    expect(highlightSquares([]).size).toBe(0);
  });

  it('reports a tapped square to the select handler', () => {
    const taps: string[] = [];
    const config = boardConfig(
      position,
      movable,
      false,
      () => undefined,
      (square) => taps.push(square),
    );
    config.events?.select?.('e4');
    expect(taps).toEqual(['e4']);
  });
});
