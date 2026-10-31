import { parseUci, type Colour, type DraftNode } from '@chess-goat/shared';
import { Chess } from 'chess.js';

export type LineToken = {
  /** Alternating opponent move, reply, …, ending with this token's move. */
  path: string[];
  san: string;
  /** `'7.'` before White's moves, `'5…'` before a Black move that starts a block, else null. */
  number: string | null;
  /** True for the owner's replies. */
  mine: boolean;
};

export type LineBlock = {
  /** How far the block is indented; stops growing at {@link MAX_DEPTH}. */
  depth: number;
  /** True for a block that starts at an alternative, not at a root branch. */
  split: boolean;
  tokens: LineToken[];
};

const MAX_DEPTH = 3;

/** Plays `uci` from `fen`: its SAN, the side that moved, the move number and the next position. */
function step(fen: string, uci: string) {
  const parsed = parseUci(uci);
  if (!parsed) throw new Error(`Not a move: ${uci}`);
  const chess = new Chess(fen);
  const white = chess.turn() === 'w';
  const fullmove = fen.split(' ')[5] ?? '1';
  const { san } = chess.move(parsed);
  return { san, white, fullmove, fen: chess.fen() };
}

/**
 * The tree as blocks of standard notation, one per line (spec, The game screen, item 5). A line
 * runs on while a reply has exactly one continuation; where a reply has two or more, each one
 * starts a block a level deeper. An opponent move without a reply ends its line.
 */
export function linesModel(
  tree: readonly DraftNode[],
  rootFen: string,
  owner: Colour,
): LineBlock[] {
  const blocks: LineBlock[] = [];

  const lay = (start: DraftNode, path: string[], fen: string, depth: number, split: boolean) => {
    const block: LineBlock = { depth, split, tokens: [] };
    blocks.push(block);
    const push = (uci: string) => {
      path = [...path, uci];
      const played = step(fen, uci);
      fen = played.fen;
      const first = block.tokens.length === 0;
      block.tokens.push({
        path,
        san: played.san,
        number: played.white ? `${played.fullmove}.` : first ? `${played.fullmove}…` : null,
        mine: played.white === (owner === 'white'),
      });
    };
    let node = start;
    for (;;) {
      push(node.move);
      if (node.reply === null) return;
      push(node.reply);
      const [only, ...others] = node.children;
      if (!only) return;
      if (others.length === 0) {
        node = only;
        continue;
      }
      for (const child of node.children) {
        lay(child, path, fen, Math.min(depth + 1, MAX_DEPTH), true);
      }
      return;
    }
  };

  for (const root of tree) lay(root, [], rootFen, 0, false);
  return blocks;
}
