import { sideToMove, t, type GameDto } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import { session } from '../../state/session';
import { setStripMinimized, stripMinimized, type StripGame } from '../../state/switcher';
import { useApp } from '../context';
import { MiniBoard } from '../MiniBoard';
import { roleOf } from '../pill';

/**
 * The strip of the viewer's games, docked above the tab bar (game switcher spec): one tap opens
 * another game in place of this one, so Back still leads to wherever the viewer came from. A
 * chevron on its top edge minimizes it, for every game, until it is opened again. It leaves with
 * the tab bar, so a move or premoves waiting for Confirm are never left by a tap.
 */
export function GameSwitcher(props: { games: StripGame[]; current: GameDto }) {
  const { router } = useApp();
  const minimized = stripMinimized.value;
  if (!router.showTabs.value) return null;
  // Another game waiting on the viewer, said by a dot on the chevron while the strip is hidden.
  const waiting = props.games.some((game) => game.id !== props.current.id && game.yourTurn);
  return (
    <div class={minimized ? 'switcher-dock minimized' : 'switcher-dock'}>
      <button
        class="switcher-toggle"
        aria-expanded={minimized ? 'false' : 'true'}
        aria-label={t(minimized ? 'app.switcher.show' : 'app.switcher.hide')}
        onClick={() => setStripMinimized(!minimized)}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        {minimized && waiting ? <span class="dot" aria-hidden="true" /> : null}
      </button>
      {minimized ? null : <Strip games={props.games} current={props.current} />}
    </div>
  );
}

/**
 * The thumbnails themselves. The game on screen is drawn from the board, so its thumbnail follows a
 * move the list has not seen yet.
 */
function Strip(props: { games: StripGame[]; current: GameDto }) {
  const { router } = useApp();
  const stripRef = useRef<HTMLElement>(null);
  const { current } = props;
  const viewerId = session.value?.user.id ?? null;

  // Opens scrolled so the game on screen is in view, centred where the strip allows.
  useEffect(() => {
    const strip = stripRef.current;
    const ringed = strip?.querySelector<HTMLElement>('.switcher-game.current');
    if (!strip || !ringed) return;
    strip.scrollLeft = ringed.offsetLeft - (strip.clientWidth - ringed.offsetWidth) / 2;
  }, []);

  return (
    <nav class="switcher" ref={stripRef} aria-label={t('app.switcher.label')}>
      {props.games.map((game) => {
        const role = roleOf(game, viewerId) ?? 'white';
        const opponent = game[role === 'white' ? 'black' : 'white'];
        const isCurrent = game.id === current.id;
        const fen = isCurrent ? current.fen : game.fen;
        const lastMove = isCurrent ? (current.moves.at(-1)?.uci ?? null) : game.lastMove;
        const yours = isCurrent
          ? current.status === 'active' && sideToMove(current.fen) === role
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
