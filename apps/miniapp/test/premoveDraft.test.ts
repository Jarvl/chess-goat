import type { DraftNode } from '@chess-goat/shared';
import { INITIAL_FEN } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import {
  extendLine,
  fenAt,
  isPrefix,
  moveLabel,
  nodeAt,
  playAt,
  removeAt,
} from '../src/state/premoveDraft';

// 1.e4 e5 2.Nf3 Nc6 3.Bc4, Black (the opponent) to move; the owner is White.
const ROOT = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

function node(move: string, reply: string | null = null, children: DraftNode[] = []): DraftNode {
  return { move, reply, children };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** g8f6 -> f3g5 { d7d5 -> e4d5 }, f8c5 -> c2c3 */
function sample(): DraftNode[] {
  return deepFreeze([node('g8f6', 'f3g5', [node('d7d5', 'e4d5')]), node('f8c5', 'c2c3')]);
}

describe('fenAt', () => {
  it('returns the root for an empty path and follows moves in order', () => {
    expect(fenAt(ROOT, [])).toBe(ROOT);
    expect(fenAt(INITIAL_FEN, ['e2e4', 'e7e5'])).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    );
  });
});

describe('nodeAt', () => {
  it('finds the level and node for each path length', () => {
    const tree = sample();
    expect(nodeAt(tree, [])).toEqual({ level: tree, node: null });
    expect(nodeAt(tree, ['f8c5'])).toEqual({ level: tree, node: tree[1] });
    expect(nodeAt(tree, ['g8f6', 'f3g5'])).toEqual({
      level: tree[0]!.children,
      node: tree[0],
    });
    expect(nodeAt(tree, ['g8f6', 'f3g5', 'd7d5'])).toEqual({
      level: tree[0]!.children,
      node: tree[0]!.children[0],
    });
  });
  it('finds nothing for a path that is not in the tree', () => {
    const tree = sample();
    expect(nodeAt(tree, ['a7a6'])).toEqual({ level: [], node: null });
    expect(nodeAt(tree, ['g8f6', 'b1c3'])).toEqual({ level: [], node: null });
  });
});

describe('playAt', () => {
  it('adds an opponent move with no reply, then fills the reply', () => {
    const added = playAt([], [], 'g8f6');
    expect(added.kind).toBe('add');
    expect(added.path).toEqual(['g8f6']);
    expect(added.tree).toEqual([node('g8f6')]);
    const replied = playAt(added.tree, added.path, 'f3g5');
    expect(replied.kind).toBe('reply');
    expect(replied.path).toEqual(['g8f6', 'f3g5']);
    expect(replied.tree).toEqual([node('g8f6', 'f3g5')]);
  });

  it('adds a second root branch after the first', () => {
    const first = playAt([], [], 'g8f6');
    const second = playAt(first.tree, [], 'f8c5');
    expect(second.kind).toBe('add');
    expect(second.path).toEqual(['f8c5']);
    const done = playAt(second.tree, second.path, 'c2c3');
    expect(done.tree).toEqual([node('g8f6'), node('f8c5', 'c2c3')]);
  });

  it('adds a branch under a reply', () => {
    const tree = sample();
    const result = playAt(tree, ['g8f6', 'f3g5'], 'h7h6');
    expect(result.kind).toBe('add');
    expect(result.path).toEqual(['g8f6', 'f3g5', 'h7h6']);
    expect(result.tree[0]!.children.map((child) => child.move)).toEqual(['d7d5', 'h7h6']);
    expect(result.tree[0]!.children[1]).toEqual(node('h7h6'));
    expect(result.tree[1]).toBe(tree[1]);
  });

  it('navigates to an existing opponent move without changing the tree', () => {
    const tree = sample();
    const result = playAt(tree, [], 'g8f6');
    expect(result.kind).toBe('navigate');
    expect(result.path).toEqual(['g8f6']);
    expect(result.tree).toEqual(tree);
    expect(result.replaced).toBeUndefined();
  });

  it('navigates when the same reply is played again', () => {
    const tree = sample();
    const result = playAt(tree, ['g8f6'], 'f3g5');
    expect(result.kind).toBe('navigate');
    expect(result.path).toEqual(['g8f6', 'f3g5']);
    expect(result.tree).toEqual(tree);
  });

  it('replaces a different reply, dropping everything under the old one', () => {
    const tree = sample();
    const result = playAt(tree, ['g8f6'], 'b1c3');
    expect(result.kind).toBe('replace');
    expect(result.replaced).toEqual({ old: 'f3g5', dropped: 2 });
    expect(result.path).toEqual(['g8f6', 'b1c3']);
    expect(result.tree).toEqual([node('g8f6', 'b1c3'), node('f8c5', 'c2c3')]);
    expect(result.tree[0]!.children).toEqual([]);
  });

  it('reports zero dropped when the old reply had nothing under it', () => {
    const result = playAt(sample(), ['f8c5'], 'd2d3');
    expect(result.kind).toBe('replace');
    expect(result.replaced).toEqual({ old: 'c2c3', dropped: 0 });
  });

  it('never mutates its input', () => {
    const tree = sample();
    expect(() => {
      playAt(tree, [], 'a7a6');
      playAt(tree, ['g8f6'], 'b1c3');
      playAt(tree, ['g8f6', 'f3g5', 'd7d5'], 'e4e5');
      playAt(tree, ['g8f6', 'f3g5'], 'h7h6');
    }).not.toThrow();
  });
});

describe('removeAt', () => {
  it('removes an opponent move with everything after it', () => {
    const tree = sample();
    const result = removeAt(tree, ['g8f6']);
    expect(result.tree).toEqual([node('f8c5', 'c2c3')]);
    expect(result.path).toEqual([]);
    expect(result.removedMoves).toBe(3);
  });

  it('removes a reply but keeps the opponent move', () => {
    const tree = sample();
    const result = removeAt(tree, ['g8f6', 'f3g5']);
    expect(result.tree).toEqual([node('g8f6'), node('f8c5', 'c2c3')]);
    expect(result.path).toEqual(['g8f6']);
    expect(result.removedMoves).toBe(2);
  });

  it('counts a lone move as zero', () => {
    const result = removeAt(deepFreeze([node('g8f6')]), ['g8f6']);
    expect(result.tree).toEqual([]);
    expect(result.removedMoves).toBe(0);
    const reply = removeAt(sample(), ['f8c5', 'c2c3']);
    expect(reply.tree[1]).toEqual(node('f8c5'));
    expect(reply.removedMoves).toBe(0);
  });

  it('removes deep inside the tree and returns the parent path', () => {
    const result = removeAt(sample(), ['g8f6', 'f3g5', 'd7d5']);
    expect(result.tree[0]).toEqual(node('g8f6', 'f3g5'));
    expect(result.path).toEqual(['g8f6', 'f3g5']);
    expect(result.removedMoves).toBe(1);
  });
});

describe('extendLine', () => {
  it('follows the first branch and reply to the end', () => {
    const tree = sample();
    expect(extendLine(tree, ['g8f6'])).toEqual(['g8f6', 'f3g5', 'd7d5', 'e4d5']);
    expect(extendLine(tree, [])).toEqual(['g8f6', 'f3g5', 'd7d5', 'e4d5']);
    expect(extendLine(tree, ['f8c5'])).toEqual(['f8c5', 'c2c3']);
    expect(extendLine(tree, ['f8c5', 'c2c3'])).toEqual(['f8c5', 'c2c3']);
  });
  it('stops at a move with no reply and leaves unknown paths alone', () => {
    expect(extendLine([node('g8f6')], [])).toEqual(['g8f6']);
    expect(extendLine(sample(), ['a7a6'])).toEqual(['a7a6']);
  });
});

describe('isPrefix', () => {
  it('is true for equal and shorter leading paths only', () => {
    expect(isPrefix([], ['a'])).toBe(true);
    expect(isPrefix(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isPrefix(['a', 'b'], ['a'])).toBe(false);
    expect(isPrefix(['a', 'c'], ['a', 'b', 'c'])).toBe(false);
  });
});

describe('moveLabel', () => {
  it('numbers White with a dot and Black with an ellipsis', () => {
    expect(moveLabel(ROOT, 'g8f6')).toBe('3…Nf6');
    expect(moveLabel(fenAt(ROOT, ['g8f6']), 'f3g5')).toBe('4.Ng5');
  });
  it('writes captures, castling and promotion in SAN', () => {
    expect(moveLabel(fenAt(ROOT, ['g8f6', 'f3g5', 'd7d5']), 'e4d5')).toBe('5.exd5');
    expect(moveLabel('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 7', 'e8g8')).toBe('7…O-O');
  });
  it('labels a promotion', () => {
    expect(moveLabel('4k3/P7/8/8/8/8/8/4K3 w - - 0 12', 'a7a8q')).toBe('12.a8=Q+');
  });
});
