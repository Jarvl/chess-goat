import type { PremoveNode } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { checkPremoveShape } from '../../src/domain/botPremoves';
import { isDomainError } from '../../src/domain/errors';

/** The error `checkPremoveShape` throws for `tree`. */
function refusal(tree: unknown) {
  try {
    checkPremoveShape(tree);
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const leaf = (move: string, reply: string): PremoveNode => ({ move, reply, children: [] });

describe('checkPremoveShape', () => {
  it('accepts a valid nested tree, legal or not, and returns plain nodes', () => {
    const tree = [
      { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5'), leaf('d7d6', 'd2d4')] },
      // Not legal anywhere near the start, but shape is all that is checked.
      { move: 'a2a1', reply: 'h7h8q', children: [], extra: 'dropped' },
    ];
    expect(checkPremoveShape(tree)).toEqual([
      { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5'), leaf('d7d6', 'd2d4')] },
      leaf('a2a1', 'h7h8q'),
    ]);
    expect(checkPremoveShape([])).toEqual([]);
  });

  it('rejects a malformed move, naming its path', () => {
    const error = refusal([
      { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5'), leaf('d7d6', 'e9e4')] },
    ]);
    expect(error.code).toBe('validation');
    expect(error.details).toMatchObject({
      reason: 'invalid_premove_tree',
      path: 'tree[0].children[1].reply',
    });
    expect(error.message).toContain('tree[0].children[1].reply');
    expect(error.message).toContain('e9e4');
  });

  it('rejects nodes that are not { move, reply, children }', () => {
    expect(refusal('e2e4').details.path).toBe('tree');
    expect(refusal([{ move: 'e7e5', reply: 'g1f3' }]).details.path).toBe('tree[0].children');
    expect(refusal([leaf('e7e5', 'g1f3'), 'x']).details.path).toBe('tree[1]');
    expect(refusal([{ move: 5, reply: 'g1f3', children: [] }]).details.path).toBe('tree[0].move');
    expect(refusal([leaf('E7E5', 'g1f3')]).details.path).toBe('tree[0].move');
  });

  it('rejects duplicate sibling moves', () => {
    const error = refusal([
      { move: 'e7e5', reply: 'g1f3', children: [leaf('b8c6', 'f1b5'), leaf('b8c6', 'f1c4')] },
    ]);
    expect(error.details.path).toBe('tree[0].children[1].move');
    expect(error.message).toContain('b8c6');
  });

  it('rejects 219 children at one node and accepts 218', () => {
    const squares = [...'abcdefgh'].flatMap((f) => [...'12345678'].map((r) => `${f}${r}`));
    const moves = squares.flatMap((from) => squares.map((to) => `${from}${to}`));
    const children = (n: number) => moves.slice(0, n).map((move) => leaf(move, 'a1a2'));
    expect(
      checkPremoveShape([{ move: 'e7e5', reply: 'g1f3', children: children(218) }]),
    ).toHaveLength(1);
    const error = refusal([{ move: 'e7e5', reply: 'g1f3', children: children(219) }]);
    expect(error.details.path).toBe('tree[0].children');
    expect(error.message).toContain('218');
    expect(refusal(children(219)).details.path).toBe('tree');
  });

  it('rejects 8,001 pairs and accepts 8,000, even in one deep line', () => {
    const line = (n: number) => {
      let tree: PremoveNode[] = [];
      for (let i = 0; i < n; i += 1) tree = [{ move: 'g8f6', reply: 'g1f3', children: tree }];
      return tree;
    };
    expect(checkPremoveShape(line(8000))).toHaveLength(1);
    const error = refusal(line(8001));
    expect(error.code).toBe('validation');
    expect(error.details.reason).toBe('invalid_premove_tree');
    expect(error.message).toContain('8000');
  });
});
