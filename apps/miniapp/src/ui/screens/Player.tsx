import { PlayerPageDtoSchema, ratingLabel, t } from '@chess-goat/shared';
import { session } from '../../state/session';
import { Avatar } from '../Avatar';
import { useApp } from '../context';
import { Flair } from '../Flair';
import { GameCard } from '../GameCard';
import { useResource } from '../hooks';
import { ErrorScreen, Loading } from './Status';

export function Player(props: { groupId: string; userId: string }) {
  const { client, router } = useApp();
  const page = useResource(`player:${props.groupId}:${props.userId}`, () =>
    client.get(`/api/groups/${props.groupId}/players/${props.userId}`, PlayerPageDtoSchema),
  );
  if (page.error) return <ErrorScreen onRetry={() => void page.reload()} />;
  if (!page.data) return <Loading />;
  const { player, headToHead, recentGames } = page.data;
  return (
    <div class="screen">
      <header class="player-head">
        <Avatar player={player} size={56} />
        <div class="grow">
          <div class="player-name">
            <h1 class="title">{player.name}</h1>
            <Flair ids={player.flair} />
          </div>
          <p class="subtitle">
            {ratingLabel(player.rating, player.provisional)} ·{' '}
            {t('app.player.record', player.record)} ·{' '}
            {t('app.player.games', { count: player.gamesPlayed })}
          </p>
        </div>
      </header>
      <p class="hint">{t('app.player.head_to_head', headToHead)}</p>
      {player.id === session.value?.user.id ? null : (
        <button
          class="btn block"
          data-action="challenge"
          onClick={() =>
            router.push({ name: 'newGame', groupId: props.groupId, opponentId: player.id })
          }
        >
          {t('app.player.challenge')}
        </button>
      )}
      <div class="section">{t('app.player.recent')}</div>
      <div class="card">
        {recentGames.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            onOpen={(gameId) => router.push({ name: 'game', gameId })}
          />
        ))}
      </div>
    </div>
  );
}
