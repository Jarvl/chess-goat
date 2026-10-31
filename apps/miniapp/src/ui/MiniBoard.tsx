import type { Colour } from '@chess-goat/shared';
import { read } from 'chessground/fen';
import type { Key } from 'chessground/types';
import { h } from 'preact';
import { memo } from 'preact/compat';

const FILES = 'abcdefgh';

/**
 * A still thumbnail of a position: the squares, the pieces, the last move tinted. Memoised
 * because a list row (`GameCard`) re-renders every second while its move clock ticks, and the
 * board's own props (fen, lastMove, orientation) never change between those ticks — without this,
 * every row re-parses its FEN and re-diffs 64 squares once a second for no visible change.
 */
function MiniBoardImpl(props: { fen: string; lastMove: string | null; orientation: Colour }) {
  const pieces = read(props.fen);
  const last = props.lastMove ? [props.lastMove.slice(0, 2), props.lastMove.slice(2, 4)] : [];
  const white = props.orientation === 'white';
  const squares = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const file = white ? col : 7 - col;
      const rank = white ? 8 - row : row + 1;
      const key = `${FILES[file]}${rank}` as Key;
      const piece = pieces.get(key);
      // a1 (file 0, rank 1) is dark, so a square is light when file + rank is even.
      const shade = (file + rank) % 2 === 0 ? 'l' : 'd';
      squares.push(
        <span
          key={key}
          class={last.includes(key) ? `sq ${shade} lm` : `sq ${shade}`}
          data-square={key}
        >
          {piece ? h('piece', { class: `${piece.role} ${piece.color}` }) : null}
        </span>,
      );
    }
  }
  return (
    <span class="mini-board cg-wrap" aria-hidden="true">
      {squares}
    </span>
  );
}

export const MiniBoard = memo(MiniBoardImpl);
