import { INITIAL_FEN } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import type { GameRow, UserRow } from '../../src/db/schema';
import { asciiBoard, drawOfferFor, GameViewSchema, renderGame } from '../../src/domain/botView';

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

describe('drawOfferFor', () => {
  it('reads a standing offer from the given side', () => {
    expect(drawOfferFor(null, 'white')).toBe('none');
    expect(drawOfferFor('white', 'white')).toBe('from_you');
    expect(drawOfferFor('white', 'black')).toBe('from_opponent');
  });
});

describe('renderGame', () => {
  const user = (id: number, over: Partial<UserRow> = {}) =>
    ({
      id,
      firstName: `U${id}`,
      username: null,
      deletedAt: null,
      isEngine: false,
      ownerId: null,
      ownerName: null,
      ...over,
    }) as UserRow;
  const game = (over: Partial<GameRow> = {}) =>
    ({
      publicId: 'g1',
      whiteId: 1,
      blackId: 2,
      status: 'active',
      result: null,
      endReason: null,
      plyCount: 0,
      fen: INITIAL_FEN,
      timePerMove: 86400,
      deadlineAt: new Date('2026-11-09T00:00:00.000Z'),
      drawOfferBy: 'black',
      rated: true,
      premoveTree: Buffer.alloc(0),
      premoveTreePly: null,
      ...over,
    }) as unknown as GameRow;
  const input = (row: GameRow) => ({
    game: row,
    moves: [],
    group: { publicId: 'grp', title: 'Chess Club' },
    white: user(1, { ownerId: 9, ownerName: '@o' }),
    black: user(2, { username: 'bob' }),
  });

  it('is what the published schema says, active or finished', () => {
    const active = renderGame(input(game()), 1);
    expect(GameViewSchema.parse(active)).toEqual(active);
    expect(active).toMatchObject({
      you: 'white',
      yourTurn: true,
      opponent: { name: '@bob', kind: 'human' },
      drawOffer: 'from_opponent',
    });
    const over = renderGame(
      input(game({ status: 'finished', result: '0-1', endReason: 'resignation' })),
      2,
    );
    expect(GameViewSchema.parse(over)).toEqual(over);
    // A finished game shows no clock, no offer and no legal moves.
    expect(over).toMatchObject({ deadlineAt: null, drawOffer: 'none', legalMoves: [] });
  });
});
