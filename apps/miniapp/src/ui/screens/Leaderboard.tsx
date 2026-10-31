import { LobbyDtoSchema, t } from '@chess-goat/shared';
import { session } from '../../state/session';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { PlayerRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

/** The group's rated table; it loads the lobby itself so it is always current (spec §3.3). */
export function Leaderboard(props: { groupId: string }) {
  const { client, router } = useApp();
  const lobby = useResource(`leaderboard:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
  );
  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  if (!lobby.data) return <Loading />;
  const { group, players } = lobby.data;
  const viewerId = session.value?.user.id ?? null;
  return (
    <div class="screen">
      <div>
        <h1 class="title">{t('app.leaderboard.title')}</h1>
        <p class="subtitle">{t('app.leaderboard.subtitle', { group: group.title })}</p>
      </div>
      {players.length === 0 ? (
        <div class="card empty">{t('app.lobby.no_players')}</div>
      ) : (
        <div class="card">
          {players.map((entry, index) => (
            <PlayerRow
              key={entry.id}
              entry={entry}
              rank={index + 1}
              you={entry.id === viewerId}
              onOpen={(userId) => router.push({ name: 'player', groupId: props.groupId, userId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
