import { PlayerPageDtoSchema, ratingLabel, t } from '@chess-goat/shared';
import { useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { session } from '../../state/session';
import { Avatar } from '../Avatar';
import { useApp } from '../context';
import { Flair } from '../Flair';
import { GameCard } from '../GameCard';
import { botActivityLabel } from '../format';
import { useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

export function Player(props: { groupId: string; userId: string }) {
  const { client, router } = useApp();
  const [announcing, setAnnouncing] = useState(false);
  const announce = async (botId: string) => {
    setAnnouncing(true);
    try {
      await client.post(`/api/groups/${props.groupId}/bots/${botId}/announce`, {});
      toast(t('app.player.announced'));
    } catch (error) {
      toast(
        error instanceof ApiError && error.code === 'rate_limited'
          ? t('app.player.announce_limit')
          : error instanceof ApiError && error.code === 'network'
            ? t('app.common.offline')
            : t('app.common.error'),
      );
    } finally {
      setAnnouncing(false);
    }
  };
  const page = useResource(`player:${props.groupId}:${props.userId}`, () =>
    client.get(`/api/groups/${props.groupId}/players/${props.userId}`, PlayerPageDtoSchema),
  );
  if (page.error) return <ErrorScreen onRetry={() => void page.reload()} />;
  if (!page.data) return <Loading />;
  const { player, headToHead, recentGames, bot, deleted } = page.data;
  const activity = botActivityLabel(player, new Date());
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
          {bot ? (
            <p class="subtitle">
              {t('app.player.owner', { owner: bot.owner })}
              {activity ? ` · ${activity}` : ''}
            </p>
          ) : null}
          {bot?.tagline ? <p class="secondary">{bot.tagline}</p> : null}
        </div>
      </header>
      <p class="hint">{t('app.player.head_to_head', headToHead)}</p>
      {player.id === session.value?.user.id || bot?.isMine || deleted ? null : (
        <button
          class="btn block"
          data-action="challenge"
          onClick={() =>
            router.push({ name: 'newGame', groupId: props.groupId, opponentId: player.id })
          }
        >
          {t(bot ? 'app.player.challenge_bot' : 'app.player.challenge')}
        </button>
      )}
      {bot?.isMine && !deleted ? (
        <button
          class="btn block"
          data-action="announce"
          disabled={announcing}
          onClick={() => void announce(player.id)}
        >
          {t('app.player.announce')}
        </button>
      ) : null}
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
