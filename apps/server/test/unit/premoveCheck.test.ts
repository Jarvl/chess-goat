import {
  INITIAL_FEN,
  PREMOVE_TREE_MAX_CHARS,
  encodePremoveTree,
  type PremoveNode,
} from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { checkTreeYielding, hasUncheckedPairs } from '../../src/domain/premoveCheck';
import { deepLine } from '../helpers/chess';

const e4e5: PremoveNode[] = [{ move: 'e2e4', reply: 'e7e5', children: [] }];
const d4d5: PremoveNode[] = [{ move: 'd2d4', reply: 'd7d5', children: [] }];

describe('checkTreeYielding', () => {
  it('gives the event loop a turn between slices and returns the check', async () => {
    const lines: PremoveNode[] = [
      { move: 'e2e4', reply: 'e7e5', children: [{ move: 'g1f3', reply: 'b8c6', children: [] }] },
      { move: 'd2d4', reply: 'd7d5', children: [] },
    ];
    // Without a yield the whole check settles in microtasks, before any immediate callback.
    let otherWork = false;
    setImmediate(() => (otherWork = true));
    expect(await checkTreeYielding(INITIAL_FEN, lines, [], 1)).toEqual({ ok: true });
    expect(otherWork).toBe(true);
    expect(
      await checkTreeYielding(INITIAL_FEN, [{ move: 'e2e4', reply: 'e7e4', children: [] }], []),
    ).toEqual({ ok: false, path: ['e2e4', 'e7e4'] });
  });

  it('gives the event loop turns while it replays a deep stored line to reach one new pair', async () => {
    const stored = deepLine(8_900).root;
    const edited = deepLine(8_900);
    edited.bottom.push({ move: 'b1c3', reply: 'b8c6', children: [] });
    expect(encodePremoveTree(edited.root).length).toBeLessThanOrEqual(PREMOVE_TREE_MAX_CHARS);
    let turns = 0;
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    try {
      expect(await checkTreeYielding(INITIAL_FEN, edited.root, stored)).toEqual({ ok: true });
    } finally {
      ticking = false;
    }
    // About 8,900 replayed pairs in slices of 256: the loop gets a turn after each slice.
    expect(turns).toBeGreaterThanOrEqual(30);
  });
});

describe('hasUncheckedPairs', () => {
  it('tells a tree with nothing to check from one with a new pair or a repeated move', () => {
    const both = [...e4e5, ...d4d5];
    expect(hasUncheckedPairs([], both)).toBe(false);
    expect(hasUncheckedPairs(e4e5, both)).toBe(false);
    expect(hasUncheckedPairs(both, e4e5)).toBe(true);
    expect(hasUncheckedPairs([{ move: 'e2e4', reply: 'd7d5', children: [] }], e4e5)).toBe(true);
    expect(hasUncheckedPairs([...e4e5, ...e4e5], e4e5)).toBe(true);
  });
});
