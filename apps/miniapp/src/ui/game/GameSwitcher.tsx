import { sideToMove, t, type GameDto } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import { session } from '../../state/session';
import type { StripGame } from '../../state/switcher';
import { useApp } from '../context';
import { MiniBoard } from '../MiniBoard';
import { roleOf } from '../pill';

/**
 * The strip of the viewer's games at the top of a game (game switcher spec): one tap opens another
 * game in place of this one, so Back still leads to wherever the viewer came from. The game on
 * screen is drawn from the board itself, so its thumbnail follows a move the list has not seen yet.
 */
export function GameSwitcher(props: { games: StripGame[]; current: GameDto }) {
  const { router } = useApp();
  const stripRef = useRef<HTMLElement>(null);
  const { current } = props;
  const viewerId = session.value?.user.id ?? null;

  // Opens scrolled so the game on screen is in view, centred where the strip allows.
  useEffect(() => {
    const strip = stripRef.current;
    const ringed = strip?.querySelector<HTMLElement>('.switch.current');
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
        const classes = ['switch', isCurrent ? 'current' : yours ? '' : 'dim'].filter(Boolean);
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
