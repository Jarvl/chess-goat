import { ratingLabel, t, type GameSummary } from '@chess-goat/shared';
import { session } from '../state/session';
import { Avatar } from './Avatar';
import { Flair } from './Flair';
import { summaryTitle, termsLabel } from './format';
import { MiniBoard } from './MiniBoard';
import { pillFor, roleOf } from './pill';
import { useNow } from './useNow';

/** One game in a list: thumbnail, opponent, terms and status (redesign spec §3.1). */
export function GameCard(props: {
  game: GameSummary;
  onOpen: (id: string) => void;
  /** The group's title, on lists that span groups. */
  context?: string;
  /** Which cards to grey out: any not waiting on the viewer (default), or finished ones only. */
  dim?: 'waiting' | 'finished';
}) {
  const { game } = props;
  const viewerId = session.value?.user.id ?? null;
  const role = roleOf(game, viewerId);
  const now = useNow(game.status === 'active' && game.deadlineAt !== null);
  const pill = pillFor(game, viewerId, now);
  const opponent = role === null ? null : game[role === 'white' ? 'black' : 'white'];
  const yours = game.status === 'active' && game.yourTurn;
  const dim = props.dim === 'finished' ? game.status === 'finished' : !yours;
  const rating = opponent
    ? opponent.isBot
      ? game.engineLevel
        ? t(`app.level.${game.engineLevel}`)
        : ''
      : ratingLabel(opponent.rating, opponent.provisional)
    : '';
  return (
    <button
      class={dim ? 'game-card dim' : 'game-card'}
      data-game={game.id}
      onClick={() => props.onOpen(game.id)}
    >
      <MiniBoard
        fen={game.fen}
        lastMove={game.lastMove}
        orientation={role === 'black' ? 'black' : 'white'}
      />
      <span class="grow">
        <span class="who">
          <Avatar player={opponent ?? game.white} size={22} />
          <span class="name">{opponent ? opponent.name : summaryTitle(game)}</span>
          {opponent ? <Flair ids={opponent.flair} /> : null}
          {rating ? <span class="rating">{rating}</span> : null}
          {role === null ? <span class="tag">{t('app.card.watching')}</span> : null}
          {game.voided ? <span class="tag">{t('app.lobby.void_badge')}</span> : null}
        </span>
        {props.context ? <span class="meta">{props.context}</span> : null}
        <span class="meta">{termsLabel(game.timePerMove, game.rated)}</span>
        <span class={`pill ${pill.kind}`}>{pill.text}</span>
      </span>
      <span class="chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
