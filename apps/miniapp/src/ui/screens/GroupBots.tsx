import { BotLobbyDtoSchema, t } from '@chess-goat/shared';
import { session } from '../../state/session';
import { useApp } from '../context';
import { GameCard } from '../GameCard';
import { useResource } from '../hooks';
import { PlayerRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

/** A group's bot-vs-bot play: games under way, the bots' table and the latest results. */
export function GroupBots(props: { groupId: string }) {
  const { client, router } = useApp();
  const lobby = useResource(`group-bots:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}/bot-lobby`, BotLobbyDtoSchema),
  );
  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  if (!lobby.data) return <Loading />;
  const { live, standings, recent } = lobby.data;
  const viewerId = session.value?.user.id ?? null;
  // Both game sections use dim="finished" so live games are not greyed out as "not your turn".
  const openGame = (gameId: string) => router.push({ name: 'game', gameId });
  const nothing = live.length === 0 && standings.length === 0 && recent.length === 0;
  return (
    <div class="screen">
      <h1 class="title">{t('app.group_bots.title')}</h1>
      <button
        class="btn block"
        data-action="browse-bots"
        onClick={() => router.push({ name: 'botBrowser', groupId: props.groupId })}
      >
        {t('app.group_bots.browse')}
      </button>
      {nothing ? <div class="card empty">{t('app.group_bots.empty')}</div> : null}
      {live.length > 0 ? (
        <>
          <div class="section">{t('app.group_bots.live')}</div>
          <div class="card">
            {live.map((game) => (
              <GameCard key={game.id} game={game} dim="finished" onOpen={openGame} />
            ))}
          </div>
        </>
      ) : null}
      {standings.length > 0 ? (
        <>
          <div class="section">{t('app.group_bots.standings')}</div>
          <div class="card">
            {standings.map((entry, index) => (
              <PlayerRow
                key={entry.id}
                entry={entry}
                rank={index + 1}
                you={entry.id === viewerId}
                onOpen={(userId) => router.push({ name: 'player', groupId: props.groupId, userId })}
              />
            ))}
          </div>
        </>
      ) : null}
      {recent.length > 0 ? (
        <>
          <div class="section">{t('app.group_bots.recent')}</div>
          <div class="card">
            {recent.map((game) => (
              <GameCard key={game.id} game={game} dim="finished" onOpen={openGame} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
