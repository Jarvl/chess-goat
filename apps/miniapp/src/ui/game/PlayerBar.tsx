import {
  material,
  ratingLabel,
  t,
  type Colour,
  type GameDto,
  type PieceLetter,
  type SideMaterial,
} from '@chess-goat/shared';
import { h } from 'preact';
import { clockLabel, isUrgent, remainingMs } from '../../state/clock';
import { Avatar } from '../Avatar';
import { Flair } from '../Flair';
import { sideResult } from './result';

const PIECE_CLASS: Record<PieceLetter, string> = {
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

/** `fen` is the confirmed position on show, so material follows the replay slider. */
export function PlayerBar(props: { dto: GameDto; colour: Colour; fen: string; now: Date }) {
  const { dto, colour } = props;
  const player = dto[colour];
  const toMove =
    dto.status === 'active' && (dto.fen.split(' ')[1] === 'b' ? 'black' : 'white') === colour;
  const yours = toMove && dto.viewerRole === colour;
  const remaining = toMove ? remainingMs(dto.deadlineAt, props.now) : null;
  const urgent = toMove && isUrgent(remaining, dto.timePerMove);
  const rating = player.isBot
    ? dto.engineLevel
      ? t(`app.level.${dto.engineLevel}`)
      : ''
    : ratingLabel(player.rating, player.provisional) +
      (dto.status === 'finished' && player.ratingAfter !== null && player.provisionalAfter !== null
        ? ` → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`
        : '');
  // Once the game is over, a result tag takes the clock's place and the reason the second line's.
  const result = sideResult(dto, colour);
  const sub =
    result?.reason ?? (yours ? t('app.lobby.your_move') : toMove ? t('app.game.to_move') : null);
  const taken: SideMaterial = material(props.fen)[colour];
  const opponent = colour === 'white' ? 'black' : 'white';
  const clockClass = ['clock', toMove && 'active', yours && 'yours', urgent && 'urgent']
    .filter(Boolean)
    .join(' ');
  return (
    <div class={yours ? 'player-bar yours' : 'player-bar'} data-colour={colour}>
      <span class={`ring ${colour}`}>
        <Avatar player={player} size={34} />
      </span>
      <span class="who">
        <span class="name-row">
          <span class="name">{player.name}</span>
          <Flair ids={player.flair} />
          {rating ? <span class="rating">{rating}</span> : null}
        </span>
        <span class="line">
          {taken.captured.length ? (
            <span class="captured cg-wrap">
              {taken.captured.map((piece) =>
                h('piece', { class: `${PIECE_CLASS[piece]} ${opponent}` }),
              )}
            </span>
          ) : null}
          {taken.lead ? <span class="lead">+{taken.lead}</span> : null}
          {sub ? (
            <span
              class={
                result?.reason ? 'sub reason' : yours ? 'sub yours' : toMove ? 'sub to-move' : 'sub'
              }
            >
              {sub}
            </span>
          ) : null}
        </span>
      </span>
      {dto.status === 'active' ? (
        <span class={clockClass}>{clockLabel(remaining, dto.timePerMove, toMove)}</span>
      ) : null}
      {result ? (
        <span class={`result-tag ${result.tag}`}>{t(`app.game.tag.${result.tag}`)}</span>
      ) : null}
    </div>
  );
}
