import { parseUci, type DraftNode } from '@group-chess/shared';
import { Chess } from 'chess.js';

/** Alternating opponent move, reply, opponent move, …, from the tree's root position. */
export type Path = readonly string[];

export type PlayResult = {
  tree: DraftNode[];
  path: string[];
  kind: 'navigate' | 'add' | 'reply' | 'replace';
  replaced?: { old: string; dropped: number };
};

/** The nodes a path passes through, and the list each one (and the path's end) lives in. */
type Trail = {
  /** `levels[0]` is the tree; `levels[i + 1]` is `nodes[i].children`. */
  levels: (readonly DraftNode[])[];
  nodes: DraftNode[];
};

/** Follows `path` down the tree; null when a move or a reply is not there. */
function walk(tree: readonly DraftNode[], path: Path): Trail | null {
  const levels: (readonly DraftNode[])[] = [tree];
  const nodes: DraftNode[] = [];
  for (let index = 0; index < path.length; index += 2) {
    const level = levels[levels.length - 1]!;
    const found = level.find((entry) => entry.move === path[index]);
    if (!found) return null;
    if (index + 1 < path.length && found.reply !== path[index + 1]) return null;
    nodes.push(found);
    levels.push(found.children);
  }
  return { levels, nodes };
}

/** Replaces the list at `levels[depth]` and rebuilds every ancestor around it. */
function setLevel(trail: Trail, depth: number, list: DraftNode[]): DraftNode[] {
  let current = list;
  for (let up = depth - 1; up >= 0; up -= 1) {
    const parent = trail.nodes[up]!;
    const siblings = trail.levels[up]!;
    current = siblings.map((entry) =>
      entry === parent ? { ...parent, children: current } : entry,
    );
  }
  return current;
}

/** Puts `next` in place of `nodes[depth]`, or drops it when `next` is null. */
function setNode(trail: Trail, depth: number, next: DraftNode | null): DraftNode[] {
  const old = trail.nodes[depth]!;
  const siblings = trail.levels[depth]!;
  const list =
    next === null
      ? siblings.filter((entry) => entry !== old)
      : siblings.map((entry) => (entry === old ? next : entry));
  return setLevel(trail, depth, list);
}

/** Moves in `list` and everything under it (replies included). */
function countMoves(list: readonly DraftNode[]): number {
  let count = 0;
  const pending = [list];
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const entry of next) {
      count += entry.reply === null ? 1 : 2;
      pending.push(entry.children);
    }
  }
  return count;
}

function apply(chess: Chess, uci: string): ReturnType<Chess['move']> {
  const parsed = parseUci(uci);
  if (!parsed) throw new Error(`Not a move: ${uci}`);
  return chess.move(parsed);
}

/** The position after playing `path` from `rootFen`. Throws on an illegal move. */
export function fenAt(rootFen: string, path: Path): string {
  const chess = new Chess(rootFen);
  for (const uci of path) apply(chess, uci);
  return chess.fen();
}

/**
 * `level` is the list the path's last opponent move lives in, or, for an even path, the list at the
 * path's end. `node` is the node of the path's last opponent move (null for the empty path). A path
 * that is not in the tree gives an empty level and no node.
 */
export function nodeAt(
  tree: readonly DraftNode[],
  path: Path,
): { level: readonly DraftNode[]; node: DraftNode | null } {
  const trail = walk(tree, path);
  if (!trail) return { level: [], node: null };
  const last = trail.nodes.length - 1;
  const odd = path.length % 2 === 1;
  return {
    level: odd ? trail.levels[last]! : trail.levels[trail.levels.length - 1]!,
    node: trail.nodes[last] ?? null,
  };
}

/** Plays `uci` at the end of `path` (spec, Building it). Never mutates `tree`. */
export function playAt(tree: readonly DraftNode[], path: Path, uci: string): PlayResult {
  const trail = walk(tree, path);
  if (!trail) throw new Error('Path is not in the tree');
  const extended = [...path, uci];
  const last = trail.nodes.length - 1;

  if (path.length % 2 === 0) {
    const level = trail.levels[trail.levels.length - 1]!;
    if (level.some((entry) => entry.move === uci)) {
      return { tree: [...tree], path: extended, kind: 'navigate' };
    }
    const added: DraftNode = { move: uci, reply: null, children: [] };
    return {
      tree: setLevel(trail, trail.levels.length - 1, [...level, added]),
      path: extended,
      kind: 'add',
    };
  }

  const node = trail.nodes[last]!;
  if (node.reply === uci) return { tree: [...tree], path: extended, kind: 'navigate' };
  if (node.reply === null) {
    return {
      tree: setNode(trail, last, { ...node, reply: uci }),
      path: extended,
      kind: 'reply',
    };
  }
  return {
    tree: setNode(trail, last, { ...node, reply: uci, children: [] }),
    path: extended,
    kind: 'replace',
    replaced: { old: node.reply, dropped: countMoves(node.children) },
  };
}

/**
 * Removes the path's last move and everything after it; returns the parent path. `removedMoves`
 * counts the moves after it.
 */
export function removeAt(
  tree: readonly DraftNode[],
  path: Path,
): { tree: DraftNode[]; path: string[]; removedMoves: number } {
  const trail = walk(tree, path);
  if (!trail) throw new Error('Path is not in the tree');
  if (path.length === 0) return { tree: [...tree], path: [], removedMoves: 0 };
  const last = trail.nodes.length - 1;
  const node = trail.nodes[last]!;
  const parent = path.slice(0, -1);
  if (path.length % 2 === 1) {
    return {
      tree: setNode(trail, last, null),
      path: parent,
      removedMoves: (node.reply === null ? 0 : 1) + countMoves(node.children),
    };
  }
  return {
    tree: setNode(trail, last, { ...node, reply: null, children: [] }),
    path: parent,
    removedMoves: countMoves(node.children),
  };
}

/** `path` followed along the first branch and the reply to the end of that line. */
export function extendLine(tree: readonly DraftNode[], path: Path): string[] {
  const trail = walk(tree, path);
  const line = [...path];
  if (!trail) return line;
  let level: readonly DraftNode[] = trail.levels[trail.levels.length - 1]!;
  if (path.length % 2 === 1) {
    const node = trail.nodes[trail.nodes.length - 1]!;
    if (node.reply === null) return line;
    line.push(node.reply);
    level = node.children;
  }
  for (let first = level[0]; first; first = level[0]) {
    line.push(first.move);
    if (first.reply === null) break;
    line.push(first.reply);
    level = first.children;
  }
  return line;
}

export function isPrefix(a: Path, b: Path): boolean {
  return a.length <= b.length && a.every((move, index) => move === b[index]);
}

/** A numbered SAN: `4.Ng5` for White, `3…Nf6` for Black. */
export function moveLabel(fen: string, uci: string): string {
  const san = apply(new Chess(fen), uci).san;
  const fullmove = fen.split(' ')[5] ?? '1';
  return `${fullmove}${fen.split(' ')[1] === 'b' ? '…' : '.'}${san}`;
}
