import type { DraftNode } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { buildTimeline, timelineTarget } from '../src/state/premoveTimeline';

function node(move: string, reply: string | null = null, children: DraftNode[] = []): DraftNode {
  return { move, reply, children };
}

/** g8f6 -> f3g5 { d7d5 -> e4d5, h7h6 -> g5f7 }, f8c5 -> c2c3 */
function sample(): DraftNode[] {
  return [node('g8f6', 'f3g5', [node('d7d5', 'e4d5'), node('h7h6', 'g5f7')]), node('f8c5', 'c2c3')];
}

const FIRST = ['g8f6', 'f3g5', 'd7d5', 'e4d5'];
const SECOND = ['g8f6', 'f3g5', 'h7h6', 'g5f7'];

describe('buildTimeline', () => {
  it('puts a waiting move before the line and ends at the line end', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree: sample(),
      selected: FIRST,
      trail: FIRST,
      earlierPly: null,
    });
    expect(timeline).toEqual({ plies: 4, rootIndex: 5, line: FIRST, end: 9, at: 9 });
  });

  it('starts the line at plies when nothing waits', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: false,
      tree: sample(),
      selected: [],
      trail: [],
      earlierPly: null,
    });
    expect(timeline).toEqual({ plies: 4, rootIndex: 4, line: FIRST, end: 8, at: 4 });
  });

  it('follows the trail when the selection is a prefix of it', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree: sample(),
      selected: ['g8f6'],
      trail: SECOND,
      earlierPly: null,
    });
    expect(timeline.line).toEqual(SECOND);
    expect(timeline.at).toBe(6);
  });

  it('ignores a trail the selection is not a prefix of', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree: sample(),
      selected: ['f8c5'],
      trail: SECOND,
      earlierPly: null,
    });
    expect(timeline.line).toEqual(['f8c5', 'c2c3']);
    expect(timeline.at).toBe(6);
  });

  it('cuts a trail to the part still in the tree, then continues along first branches', () => {
    const tree = [node('g8f6', 'f3g5', [node('d7d5', 'e4d5')])];
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree,
      selected: ['g8f6'],
      trail: SECOND,
      earlierPly: null,
    });
    expect(timeline.line).toEqual(FIRST);
  });

  it('cuts a trail whose last reply changed', () => {
    const tree = [node('g8f6', 'a2a3')];
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree,
      selected: ['g8f6'],
      trail: ['g8f6', 'f3g5'],
      earlierPly: null,
    });
    expect(timeline.line).toEqual(['g8f6', 'a2a3']);
  });

  it('handles an empty tree', () => {
    const timeline = buildTimeline({
      plies: 3,
      waiting: true,
      tree: [],
      selected: [],
      trail: [],
      earlierPly: null,
    });
    expect(timeline).toEqual({ plies: 3, rootIndex: 4, line: [], end: 4, at: 4 });
  });

  it('keeps an unanswered opponent move at the end of the line', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: false,
      tree: [node('g8f6')],
      selected: ['g8f6'],
      trail: ['g8f6'],
      earlierPly: null,
    });
    expect(timeline).toMatchObject({ line: ['g8f6'], end: 5, at: 5 });
  });

  it('puts the position on an earlier ply when one is set', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree: sample(),
      selected: FIRST,
      trail: FIRST,
      earlierPly: 2,
    });
    expect(timeline.at).toBe(2);
  });

  it('puts the position before the waiting move at plies', () => {
    const timeline = buildTimeline({
      plies: 4,
      waiting: true,
      tree: sample(),
      selected: [],
      trail: FIRST,
      earlierPly: 4,
    });
    expect(timeline.at).toBe(4);
  });
});

describe('timelineTarget', () => {
  const timeline = buildTimeline({
    plies: 4,
    waiting: true,
    tree: sample(),
    selected: FIRST,
    trail: FIRST,
    earlierPly: null,
  });

  it('goes to the tree root at rootIndex', () => {
    expect(timelineTarget(timeline, 5)).toEqual({ earlierPly: null, selected: [] });
  });

  it('goes to the position before the waiting move', () => {
    expect(timelineTarget(timeline, 4)).toEqual({ earlierPly: 4, selected: [] });
  });

  it('goes to an earlier ply', () => {
    expect(timelineTarget(timeline, 2)).toEqual({ earlierPly: 2, selected: [] });
  });

  it('selects a prefix of the line', () => {
    expect(timelineTarget(timeline, 7)).toEqual({ earlierPly: null, selected: FIRST.slice(0, 2) });
    expect(timelineTarget(timeline, 9)).toEqual({ earlierPly: null, selected: FIRST });
  });

  it('clamps to both ends', () => {
    expect(timelineTarget(timeline, -3)).toEqual({ earlierPly: 0, selected: [] });
    expect(timelineTarget(timeline, 40)).toEqual({ earlierPly: null, selected: FIRST });
  });

  it('treats plies as the root when nothing waits', () => {
    const plain = buildTimeline({
      plies: 4,
      waiting: false,
      tree: sample(),
      selected: [],
      trail: [],
      earlierPly: null,
    });
    expect(timelineTarget(plain, 4)).toEqual({ earlierPly: null, selected: [] });
    expect(timelineTarget(plain, 3)).toEqual({ earlierPly: 3, selected: [] });
  });

  it('returns to the same non-first branch going back and forward', () => {
    const tree = sample();
    const start = buildTimeline({
      plies: 4,
      waiting: true,
      tree,
      selected: SECOND,
      trail: SECOND,
      earlierPly: null,
    });
    const back = timelineTarget(start, 6);
    const middle = buildTimeline({
      plies: 4,
      waiting: true,
      tree,
      selected: back.selected,
      trail: SECOND,
      earlierPly: back.earlierPly,
    });
    expect(middle.line).toEqual(SECOND);
    expect(timelineTarget(middle, 9).selected).toEqual(SECOND);
  });
});
