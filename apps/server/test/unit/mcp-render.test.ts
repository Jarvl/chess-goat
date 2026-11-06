import { INITIAL_FEN } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { asciiBoard } from '../../src/mcp/render';

describe('asciiBoard', () => {
  it('draws the start position from white, rank 8 at the top', () => {
    expect(asciiBoard(INITIAL_FEN, 'white')).toBe(
      [
        '8 r n b q k b n r',
        '7 p p p p p p p p',
        '6 . . . . . . . .',
        '5 . . . . . . . .',
        '4 . . . . . . . .',
        '3 . . . . . . . .',
        '2 P P P P P P P P',
        '1 R N B Q K B N R',
        '  a b c d e f g h',
      ].join('\n'),
    );
  });

  it('draws it from black, rank 1 at the top and files reversed', () => {
    expect(asciiBoard(INITIAL_FEN, 'black')).toBe(
      [
        '1 R N B K Q B N R',
        '2 P P P P P P P P',
        '3 . . . . . . . .',
        '4 . . . . . . . .',
        '5 . . . . . . . .',
        '6 . . . . . . . .',
        '7 p p p p p p p p',
        '8 r n b k q b n r',
        '  h g f e d c b a',
      ].join('\n'),
    );
  });
});
