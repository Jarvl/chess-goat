import type { DraftNode } from '@group-chess/shared';
import { extendLine, isPrefix, nodeAt, type Path } from './premoveDraft';

/**
 * The one replay slider: the game's real plies (0..plies), the player's move waiting for Confirm
 * (index `plies + 1`, if any), then the premove line being viewed.
 */
export type Timeline = {
  plies: number;
  /** The index of the premove tree's root position. */
  rootIndex: number;
  line: string[];
  end: number;
  /** The index being shown. */
  at: number;
};

export type TimelineTarget = { earlierPly: number | null; selected: string[] };

/** The longest prefix of `path` that exists in `tree`. */
function validPrefix(tree: readonly DraftNode[], path: Path): Path {
  let length = path.length;
  while (length > 0 && nodeAt(tree, path.slice(0, length)).node === null) length -= 1;
  return path.slice(0, length);
}

export function buildTimeline(input: {
  plies: number;
  waiting: boolean;
  tree: readonly DraftNode[];
  selected: Path;
  trail: Path;
  earlierPly: number | null;
}): Timeline {
  const { plies, waiting, tree, selected, trail, earlierPly } = input;
  const rootIndex = plies + (waiting ? 1 : 0);
  const base = isPrefix(selected, trail) ? validPrefix(tree, trail) : selected;
  const line = extendLine(tree, base);
  return {
    plies,
    rootIndex,
    line,
    end: rootIndex + line.length,
    at: earlierPly ?? rootIndex + selected.length,
  };
}

/** Where the slider moves the state for `index` (clamped to the timeline). */
export function timelineTarget(timeline: Timeline, index: number): TimelineTarget {
  const clamped = Math.min(Math.max(Math.trunc(index), 0), timeline.end);
  if (clamped < timeline.rootIndex) return { earlierPly: clamped, selected: [] };
  return { earlierPly: null, selected: timeline.line.slice(0, clamped - timeline.rootIndex) };
}
