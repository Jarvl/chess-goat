import { ratingLabel, t, type ChallengeDto, type LeaderboardEntry } from '@chess-goat/shared';
import { Avatar } from './Avatar';
import { Flair } from './Flair';
import { termsLabel } from './format';

export function ChallengeCard(props: {
  challenge: ChallengeDto;
  viewerId: string | null;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { challenge } = props;
  const challenger = challenge.challenger.name;
  const line =
    challenge.opponentUsername !== null
      ? challenge.viewer.canAccept
        ? t('app.lobby.challenge.you', { challenger })
        : t('app.lobby.challenge.direct', {
            challenger,
            opponent: `@${challenge.opponentUsername}`,
          })
      : challenge.opponent === null
        ? t('app.lobby.challenge.open', { challenger })
        : challenge.opponent.id === props.viewerId
          ? t('app.lobby.challenge.you', { challenger })
          : t('app.lobby.challenge.direct', { challenger, opponent: challenge.opponent.name });
  return (
    <div class="challenge">
      <div class="challenge-who">
        <Avatar player={challenge.challenger} size={40} />
        <span class="grow">
          <span class="primary">{line}</span>
          <span class="secondary">{termsLabel(challenge.timePerMove, challenge.rated)}</span>
        </span>
      </div>
      <div class="challenge-actions">
        {challenge.viewer.canAccept ? (
          <button
            class="pill-btn primary"
            data-accept={challenge.id}
            onClick={() => props.onAccept(challenge.id)}
          >
            {t('button.accept')}
          </button>
        ) : null}
        {challenge.viewer.canDecline ? (
          <button
            class="pill-btn"
            data-decline={challenge.id}
            onClick={() => props.onDecline(challenge.id)}
          >
            {t('button.decline')}
          </button>
        ) : null}
        {challenge.viewer.canCancel ? (
          <button
            class="pill-btn"
            data-cancel={challenge.id}
            onClick={() => props.onCancel(challenge.id)}
          >
            {t('button.cancel')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PlayerRow(props: {
  entry: LeaderboardEntry;
  rank: number;
  you: boolean;
  onOpen: (id: string) => void;
}) {
  const { entry } = props;
  // "(you)" is part of the name's text, as in the prototype, so the two ellipsise together and the
  // flair and rating beside them stay whole (flair spec §5.1).
  const name = props.you ? `${entry.name} ${t('app.leaderboard.you')}` : entry.name;
  return (
    <button
      class={props.you ? 'player-row you' : 'player-row'}
      data-player={entry.id}
      onClick={() => props.onOpen(entry.id)}
    >
      <span class={props.rank === 1 ? 'rank first' : 'rank'}>{props.rank}</span>
      <Avatar player={entry} size={40} />
      <span class="grow">
        <span class="name-row">
          <span class="name">{name}</span>
          <Flair ids={entry.flair} />
          <span class="rating">{ratingLabel(entry.rating, entry.provisional)}</span>
        </span>
        <span class="secondary">{t('app.player.record', entry.record)}</span>
      </span>
      <span class="hint">{t('app.player.games', { count: entry.gamesPlayed })}</span>
    </button>
  );
}
