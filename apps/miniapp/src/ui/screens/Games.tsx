import { MeGamesDtoSchema, t } from '@chess-goat/shared';
import { useEffect } from 'preact/hooks';
import { BRAND } from '../../brand';
import { countYourMove } from '../../state/yourMove';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { GameCard } from '../GameCard';
import { ErrorScreen, Loading } from './Status';

/** The Mini App's home: every board waiting on you, across all your groups, your move first. */
export function Games() {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.games;
  delete prefetched.games;
  const games = useResource('games', () => client.get('/api/me/games', MeGamesDtoSchema), initial);
  // The full list outranks the badge's running count, so every load resets it.
  useEffect(() => {
    if (games.data) countYourMove(games.data);
  }, [games.data]);
  if (games.error) return <ErrorScreen onRetry={() => void games.reload()} />;
  if (!games.data) return <Loading />;
  const items = games.data.items;
  const waiting = items.filter((game) => game.yourTurn).length;
  return (
    <div class="screen">
      <header class="home-head">
        <img class="goat-mark" src={BRAND.markUrl} alt="" width={42} height={42} />
        <h1 class="title">{t('app.games.title')}</h1>
      </header>
      {items.length === 0 ? (
        <div class="card empty">
          <span>{t('app.games.empty')}</span>
          <button
            class="btn block"
            data-action="browse-groups"
            onClick={() => router.select('groups')}
          >
            {t('app.games.browse')}
          </button>
        </div>
      ) : (
        <>
          <div class="section">
            {t('app.games.summary', {
              games:
                items.length === 1
                  ? t('app.games.count.one')
                  : t('app.games.count.other', { count: items.length }),
              yourMove: waiting,
            })}
          </div>
          <div class="card">
            {items.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                context={game.group.title}
                onOpen={(gameId) => router.push({ name: 'game', gameId })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
