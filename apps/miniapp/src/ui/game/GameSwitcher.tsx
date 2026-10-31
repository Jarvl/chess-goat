import { sideToMove, t, type GameDto } from '@chess-goat/shared';
import { useEffect, useRef } from 'preact/hooks';
import { session } from '../../state/session';
import {
  dock,
  setStripMinimized,
  stripMinimized,
  stripScroll,
  type StripGame,
} from '../../state/switcher';
import { useApp } from '../context';
import { MiniBoard } from '../MiniBoard';
import { roleOf } from '../pill';

/** The strip's id, for the chevron that opens and closes it to point at. */
const STRIP_ID = 'switcher-games';

/** Room left beside the game on screen when the strip scrolls it into view: the strip's padding. */
const SCROLL_MARGIN = 12;

/**
 * The strip of the viewer's games, docked above the tab bar (game switcher spec): one tap opens
 * another game in place of this one, so Back still leads to wherever the viewer came from. A
 * chevron on its top edge minimizes it, for every game, until it is opened again. It leaves with
 * the tab bar, so a move or premoves waiting for Confirm are never left by a tap.
 */
export function GameSwitcher(props: {
  games: StripGame[];
  currentId: string;
  /** The game on screen, once loaded: its thumbnail is drawn from the live board. */
  live?: GameDto;
}) {
  const { router } = useApp();
  const minimized = stripMinimized.value;
  const shown = router.showTabs.value;
  useEffect(() => {
    dock.value = shown ? (minimized ? 'minimized' : 'open') : null;
    return () => {
      dock.value = null;
    };
  }, [shown, minimized]);
  if (!shown) return null;
  // Another game waiting on the viewer, said by a dot on the chevron while the strip is hidden.
  const waiting = props.games.some((game) => game.id !== props.currentId && game.yourTurn);
  return (
    <div class={minimized ? 'switcher-dock minimized' : 'switcher-dock'}>
      <button
        class="switcher-toggle"
        aria-expanded={minimized ? 'false' : 'true'}
        aria-controls={minimized ? undefined : STRIP_ID}
        aria-label={t(minimized ? 'app.switcher.show' : 'app.switcher.hide')}
        onClick={() => setStripMinimized(!minimized)}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        {minimized && waiting ? <span class="dot" aria-hidden="true" /> : null}
      </button>
      {minimized ? null : (
        <Strip games={props.games} currentId={props.currentId} live={props.live} />
      )}
    </div>
  );
}

/**
 * The thumbnails themselves. The game on screen is drawn from the board, so its thumbnail follows a
 * move the list has not seen yet.
 */
function Strip(props: { games: StripGame[]; currentId: string; live?: GameDto }) {
  const { router } = useApp();
  const stripRef = useRef<HTMLElement>(null);
  const { currentId, live } = props;
  const viewerId = session.value?.user.id ?? null;

  // A hop finds the strip where it was left, so nothing moves under the thumb, nudged only if the
  // game on screen is out of view; an arrival centres that game where the strip allows.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const ringed = strip.querySelector<HTMLElement>('.switcher-game.current');
    if (stripScroll.left === null) {
      if (ringed)
        strip.scrollLeft = ringed.offsetLeft - (strip.clientWidth - ringed.offsetWidth) / 2;
      return;
    }
    strip.scrollLeft = stripScroll.left;
    if (!ringed) return;
    const left = ringed.offsetLeft - SCROLL_MARGIN;
    const right = ringed.offsetLeft + ringed.offsetWidth + SCROLL_MARGIN - strip.clientWidth;
    if (strip.scrollLeft > left) strip.scrollLeft = left;
    else if (strip.scrollLeft < right) strip.scrollLeft = right;
  }, []);

  return (
    <nav
      id={STRIP_ID}
      class="switcher"
      ref={stripRef}
      aria-label={t('app.switcher.label')}
      onScroll={(event) => (stripScroll.left = event.currentTarget.scrollLeft)}
    >
      {props.games.map((game) => {
        const role = roleOf(game, viewerId) ?? 'white';
        const opponent = game[role === 'white' ? 'black' : 'white'];
        const isCurrent = game.id === currentId;
        const fromBoard = isCurrent ? live : undefined;
        const fen = fromBoard ? fromBoard.fen : game.fen;
        const lastMove = fromBoard ? (fromBoard.moves.at(-1)?.uci ?? null) : game.lastMove;
        const yours = fromBoard
          ? fromBoard.status === 'active' && sideToMove(fromBoard.fen) === role
          : game.status === 'active' && game.yourTurn;
        const classes = ['switcher-game', isCurrent ? 'current' : yours ? '' : 'dim'].filter(
          Boolean,
        );
        return (
          <button
            key={game.id}
            class={classes.join(' ')}
            data-switch={game.id}
            aria-current={isCurrent ? 'true' : undefined}
            aria-label={t(yours ? 'app.switcher.yours' : 'app.switcher.theirs', {
              name: opponent.name,
            })}
            onClick={() => {
              if (!isCurrent) router.replace({ name: 'game', gameId: game.id, hop: true });
            }}
          >
            <span class="thumb">
              <MiniBoard fen={fen} lastMove={lastMove} orientation={role} />
              {yours ? <span class="dot" aria-hidden="true" /> : null}
            </span>
            <span class="name">{opponent.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
