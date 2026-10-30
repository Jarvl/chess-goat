import { t } from '@group-chess/shared';
import { Chess } from 'chess.js';
import { useEffect, useRef } from 'preact/hooks';
import type { GameStore } from '../../state/game';
import { useApp } from '../context';

/** The SAN of each move of `line`, played from `rootFen`; a move that does not play reads as its UCI. */
function lineLabels(rootFen: string, line: readonly string[]): string[] {
  const labels: string[] = [];
  try {
    const chess = new Chess(rootFen);
    for (const uci of line) {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4],
      });
      labels.push(move.san);
    }
  } catch {
    // A line that stops being legal is cut short below.
  }
  return line.map((uci, index) => labels[index] ?? uci);
}

/**
 * The strip: the game's real moves, the player's waiting move, then the premove line being viewed.
 * `locked` while a move waits for Confirm move: the board holds that move, so the real moves can't
 * be tapped; the waiting move and the line still can. The ✕ follows the selected line move.
 */
export function MoveList(props: { store: GameStore; locked?: boolean; onRemove?: () => void }) {
  const { store } = props;
  const { tg } = useApp();
  const dto = store.dto.value;
  const moves = dto.moves;
  const timeline = store.timeline.value;
  const waiting = store.waiting.value;
  const { at, line, rootIndex } = timeline;
  const labels = lineLabels(store.rootFen.value, line);
  const removable = store.viewingPly.value === null && at > rootIndex;
  const strip = useRef<HTMLDivElement>(null);
  // Keeps the current move, and its ✕, in view whenever the strip or the position changes.
  useEffect(() => {
    const element = strip.current;
    const here = element?.querySelector<HTMLElement>('button[aria-current="true"]');
    if (!element || !here) return;
    const end = element.querySelector<HTMLElement>('.premove-remove') ?? here;
    const right = end.offsetLeft + end.offsetWidth;
    if (right > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = right - element.clientWidth;
    }
    if (here.offsetLeft < element.scrollLeft) element.scrollLeft = here.offsetLeft;
  }, [moves.length, waiting?.uci, line.join(), at]);
  if (moves.length === 0 && !waiting && line.length === 0)
    return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  const view = (index: number) => {
    if (store.viewTimeline(index)) tg.hapticSelection();
  };
  const number = (ply: number, extra = '') =>
    ply % 2 === 1 ? <span class={`number${extra}`}>{Math.ceil(ply / 2)}.</span> : null;
  return (
    <div class="move-list" ref={strip}>
      {moves.map((move) => (
        <>
          {number(move.ply)}
          <button
            key={move.ply}
            data-ply={move.ply}
            aria-current={at === move.ply ? 'true' : 'false'}
            disabled={props.locked}
            onClick={() => view(move.ply)}
          >
            {move.san}
          </button>
        </>
      ))}
      {waiting ? (
        <>
          {number(dto.plyCount + 1)}
          <button
            key="waiting"
            class="waiting"
            data-waiting
            aria-current={at === dto.plyCount + 1 ? 'true' : 'false'}
            onClick={() => view(dto.plyCount + 1)}
          >
            {waiting.san}
          </button>
        </>
      ) : null}
      {line.map((_, index) => {
        const ply = rootIndex + index + 1;
        // The line alternates the opponent's move and the player's reply, opponent first.
        const own = index % 2 === 1;
        const shown = at === ply;
        return (
          <>
            {number(ply, ' premove-number')}
            <button
              key={`line-${index}`}
              class={own ? 'premove-chip' : 'line-opponent'}
              data-line={index}
              aria-current={shown ? 'true' : 'false'}
              onClick={() => view(ply)}
            >
              {labels[index]}
            </button>
            {shown && removable && props.onRemove ? (
              <button
                class="premove-remove"
                data-action="premove-remove"
                aria-label={t('app.game.premove_remove')}
                onClick={() => props.onRemove?.()}
              >
                ✕
              </button>
            ) : null}
          </>
        );
      })}
    </div>
  );
}
