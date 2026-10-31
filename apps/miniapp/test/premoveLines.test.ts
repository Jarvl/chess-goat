import type { DraftNode } from '@chess-goat/shared';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { linesModel, type LineBlock } from '../src/state/premoveLines';

// 1.e4 e5 2.Nf3 Nc6 3.Bc4, Black (the opponent) to move; the owner is White.
const ROOT = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

/** SAN moves from `fen` as UCI. */
function ucis(fen: string, sans: string[]): string[] {
  const chess = new Chess(fen);
  return sans.map((san) => {
    const move = chess.move(san);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  });
}

/** A single line: opponent move, reply, … ; an odd count leaves the last opponent move unanswered. */
function chain(fen: string, sans: string[], tail: DraftNode[] = []): DraftNode[] {
  const moves = ucis(fen, sans);
  let children = tail;
  const pairs: [string, string | null][] = [];
  for (let i = 0; i < moves.length; i += 2) pairs.push([moves[i]!, moves[i + 1] ?? null]);
  for (let i = pairs.length - 1; i >= 0; i -= 1) {
    const [move, reply] = pairs[i]!;
    children = [{ move, reply, children }];
  }
  return children;
}

// 3…Nb4 4.d3 Nxd3+ 5.Bxd3 d6 6.O-O Nf6 7.Nc3 Bg4 8.h3 Bh5 9.Bg5 Be7 10.Nd5 O-O 11.Nxe7+ Qxe7
const LONG = [
  'Nb4',
  'd3',
  'Nxd3+',
  'Bxd3',
  'd6',
  'O-O',
  'Nf6',
  'Nc3',
  'Bg4',
  'h3',
  'Bh5',
  'Bg5',
  'Be7',
  'Nd5',
  'O-O',
  'Nxe7+',
  'Qxe7',
];

const sanOf = (block: LineBlock) => block.tokens.map((token) => token.san);

describe('linesModel', () => {
  it('lays a single chain out as one block with standard numbering', () => {
    const blocks = linesModel(chain(ROOT, LONG), ROOT, 'white');
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block).toMatchObject({ depth: 0, split: false });
    expect(sanOf(block)).toEqual(LONG);
    expect(block.tokens.map((token) => token.number).slice(0, 6)).toEqual([
      '3…',
      '4.',
      null,
      '5.',
      null,
      '6.',
    ]);
    expect(block.tokens.map((token) => token.mine).slice(0, 4)).toEqual([false, true, false, true]);
    expect(block.tokens[2]!.path).toEqual(ucis(ROOT, LONG.slice(0, 3)));
    expect(block.tokens[0]!.path).toEqual(ucis(ROOT, LONG.slice(0, 1)));
  });

  it('starts split blocks, numbered from a Black move, where the opponent has alternatives', () => {
    const beforeSplit = ['Nb4', 'd3', 'Nxd3+', 'Bxd3'];
    const afterSplit = new Chess(ROOT);
    for (const san of beforeSplit) afterSplit.move(san);
    const tail: DraftNode[] = [
      ...chain(afterSplit.fen(), ['d6', 'O-O', 'Nf6', 'Nc3']),
      ...chain(afterSplit.fen(), ['Qe7', 'O-O']),
    ];
    const blocks = linesModel(chain(ROOT, beforeSplit, tail), ROOT, 'white');
    expect(blocks.map(sanOf)).toEqual([
      ['Nb4', 'd3', 'Nxd3+', 'Bxd3'],
      ['d6', 'O-O', 'Nf6', 'Nc3'],
      ['Qe7', 'O-O'],
    ]);
    expect(blocks.map((block) => [block.depth, block.split])).toEqual([
      [0, false],
      [1, true],
      [1, true],
    ]);
    expect(blocks[1]!.tokens[0]!.number).toBe('5…');
    expect(blocks[2]!.tokens[0]!.number).toBe('5…');
    expect(blocks[2]!.tokens[1]!.number).toBe('6.');
    expect(blocks[1]!.tokens[0]!.path).toEqual(ucis(ROOT, [...beforeSplit, 'd6']));
  });

  it('makes each root branch a block at depth 0', () => {
    const tree = [...chain(ROOT, ['Nb4', 'd3']), ...chain(ROOT, ['Bc5', 'c3'])];
    const blocks = linesModel(tree, ROOT, 'white');
    expect(blocks.map((block) => [block.depth, block.split])).toEqual([
      [0, false],
      [0, false],
    ]);
    expect(blocks.map(sanOf)).toEqual([
      ['Nb4', 'd3'],
      ['Bc5', 'c3'],
    ]);
  });

  it('ends a line at an unanswered opponent move, which is shown like any other', () => {
    const blocks = linesModel(chain(ROOT, ['Nb4', 'd3', 'Nxd3+']), ROOT, 'white');
    expect(blocks).toHaveLength(1);
    expect(sanOf(blocks[0]!)).toEqual(['Nb4', 'd3', 'Nxd3+']);
    expect(blocks[0]!.tokens.at(-1)).toMatchObject({ mine: false, number: null });
  });

  it('numbers a Black owner reply as a continuation after a White opponent move', () => {
    const start = new Chess().fen();
    const blocks = linesModel(chain(start, ['e4', 'e5', 'Nf3']), start, 'black');
    expect(blocks[0]!.tokens.map((token) => token.number)).toEqual(['1.', null, '2.']);
    expect(blocks[0]!.tokens.map((token) => token.mine)).toEqual([false, true, false]);
  });

  it('never indents past depth 3, branching at every level', () => {
    function build(fen: string, levels: number): DraftNode[] {
      if (levels === 0) return [];
      const chess = new Chess(fen);
      return chess
        .moves({ verbose: true })
        .slice(0, 2)
        .map((opponent) => {
          const next = new Chess(fen);
          next.move(opponent);
          const reply = next.moves({ verbose: true })[0]!;
          next.move(reply);
          return {
            move: `${opponent.from}${opponent.to}${opponent.promotion ?? ''}`,
            reply: `${reply.from}${reply.to}${reply.promotion ?? ''}`,
            children: build(next.fen(), levels - 1),
          };
        });
    }
    const start = new Chess().fen();
    const white = build(start, 6);
    const blocks = linesModel(white, start, 'black');
    // Every node has a sibling, so each starts a block: 2 + 4 + … + 64.
    expect(blocks).toHaveLength(126);
    expect(Math.max(...blocks.map((block) => block.depth))).toBe(3);
    expect(blocks.every((block) => block.depth <= 3)).toBe(true);
    expect(blocks.filter((block) => block.split).every((block) => block.depth >= 1)).toBe(true);
  });
});
