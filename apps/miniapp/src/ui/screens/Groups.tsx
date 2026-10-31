import { MeGroupsDtoSchema, t } from '@chess-goat/shared';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { GroupAvatar } from '../Avatar';
import { ErrorScreen, Loading } from './Status';

export function Groups() {
  const { client, router } = useApp();
  // Not prefetched: the launch response paints the Games home, and reaching this tab is a
  // lateral move, so one fetch here costs nothing against the first-paint budget (spec §6.5).
  const groups = useResource('groups', () => client.get('/api/me/groups', MeGroupsDtoSchema));
  if (groups.error) return <ErrorScreen onRetry={() => void groups.reload()} />;
  if (!groups.data) return <Loading />;
  return (
    <div class="screen">
      <h1 class="title">{t('app.groups.title')}</h1>
      {groups.data.groups.length === 0 ? (
        <div class="card empty">{t('app.groups.empty')}</div>
      ) : (
        <div class="stack">
          {groups.data.groups.map((group) => (
            <button
              key={group.id}
              class="group-row"
              data-group={group.id}
              onClick={() => router.push({ name: 'lobby', groupId: group.id })}
            >
              <GroupAvatar group={group} size={48} />
              <span class="grow">
                <span class="primary">{group.title}</span>
                <span class="secondary">
                  {t('app.groups.summary', { active: group.activeGames, yourMove: group.yourMove })}
                </span>
              </span>
              {group.yourMove > 0 ? <span class="count-badge">{group.yourMove}</span> : null}
              <span class="chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
