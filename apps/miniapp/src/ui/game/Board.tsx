import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import {
  createBoardAdapter,
  type BoardAdapter,
  type BoardPosition,
  type MoveHandler,
  type SelectHandler,
} from '../../board/adapter';
import type { GameStore } from '../../state/game';

/** Two pushes of the same position are one: a snapshot that changes nothing on the board. */
function positionKey(position: BoardPosition): string {
  return [
    position.fen,
    position.lastMove?.join('') ?? '',
    position.check,
    position.orientation,
    position.turnColour,
  ].join('|');
}

/**
 * Mounts the adapter once and pushes position, movable set and view-only flag from the store.
 * While premoves are built, the side to move in the shown position is the one that moves
 * (conditional premoves spec, Mini App: Board), and the selected premove is highlighted.
 */
export function Board(props: {
  store: GameStore;
  onMove: MoveHandler;
  onReady: (adapter: BoardAdapter) => void;
  /** Every tap on a square. */
  onSelect?: SelectHandler;
  children?: preact.ComponentChildren;
}) {
  const element = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(props.onMove);
  onMoveRef.current = props.onMove;
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const { store } = props;
  useEffect(() => {
    const spectator = store.dto.value.viewerRole === 'spectator';
    const shown = (): BoardPosition => ({
      ...store.boardView.value,
      orientation: store.orientation.value,
      turnColour: store.boardTurn.value,
    });
    let pushed = '';
    const adapter = createBoardAdapter(element.current!, shown(), { viewOnly: spectator });
    adapter.onMove((orig, dest, meta) => onMoveRef.current(orig, dest, meta));
    props.onReady(adapter);
    adapter.onSelect((square) => onSelectRef.current?.(square));
    const disposers = [
      effect(() => {
        const next = shown();
        const key = positionKey(next);
        if (key === pushed) return;
        pushed = key;
        adapter.setPosition(next);
      }),
      effect(() =>
        adapter.setMovable({
          colour: store.canMove.value ? store.boardTurn.value : 'none',
          dests: store.dests.value,
        }),
      ),
      effect(() => adapter.setViewOnly(store.dto.value.viewerRole === 'spectator')),
      effect(() => adapter.setHighlights(store.highlights.value)),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      adapter.destroy();
    };
  }, [store]);
  return (
    <div class={store.building.value ? 'board-wrap premove' : 'board-wrap'}>
      <div ref={element} />
      {props.children}
    </div>
  );
}
