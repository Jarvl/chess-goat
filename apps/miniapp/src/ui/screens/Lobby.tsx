import {
  FinishedPageDtoSchema,
  GameDtoSchema,
  LobbyDtoSchema,
  ratingLabel,
  t,
  type LobbyDto,
} from '@chess-goat/shared';
import { useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { rankOf, scopedGames, type LobbyScope } from '../../state/lobby';
import { session } from '../../state/session';
import { GameCard } from '../GameCard';
import { useApp } from '../context';
import { Segmented } from '../controls';
import { useResource } from '../hooks';
import { GEAR_PATH } from '../icons';
import { ChallengeCard } from '../rows';
import { toast } from '../toast';
import { GroupAvatar } from '../Avatar';
import { ErrorScreen, Loading } from './Status';

export function Lobby(props: { groupId: string; scope?: LobbyScope }) {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.lobby?.group.id === props.groupId ? prefetched.lobby : undefined;
  if (initial) delete prefetched.lobby;
  const lobby = useResource<LobbyDto>(
    `lobby:${props.groupId}`,
    () => client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
    initial,
  );
  // Kept on the route entry, so a game opened from Others comes back to Others.
  const scope = props.scope ?? 'mine';
  const setScope = (next: LobbyScope) =>
    router.replace({ name: 'lobby', groupId: props.groupId, scope: next });
  const [loadingMore, setLoadingMore] = useState(false);

  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  const data = lobby.data;
  if (!data) return <Loading />;

  const viewerId = session.value?.user.id ?? null;
  const { active, finished } = scopedGames(data, scope, viewerId);
  const waiting = data.active.filter((game) => game.yourTurn).length;
  const ranked = rankOf(data.players, viewerId);
  const rankedPlayers =
    data.players.length === 1
      ? t('app.lobby.ranked.one')
      : t('app.lobby.ranked.other', { count: data.players.length });

  const openGame = (gameId: string) => router.push({ name: 'game', gameId });
  const act = async (path: string, after: () => void | Promise<void>) => {
    try {
      await client.post(path, {});
      await after();
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'network') await lobby.reload();
      else toast(t('app.common.offline'));
    }
  };
  const accept = async (id: string) => {
    try {
      const game = await client.post(`/api/challenges/${id}/accept`, {}, GameDtoSchema);
      prefetched.game = game;
      router.push({ name: 'game', gameId: game.id });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_state')
        toast(t('alert.accepted_first'));
      await lobby.reload();
    }
  };
  const more = async () => {
    if (!data.finished.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.get(
        `/api/groups/${props.groupId}/finished?cursor=${encodeURIComponent(data.finished.nextCursor)}`,
        FinishedPageDtoSchema,
      );
      lobby.set({
        ...data,
        finished: { items: [...data.finished.items, ...page.items], nextCursor: page.nextCursor },
      });
    } catch (error) {
      toast(
        error instanceof ApiError && error.isNetwork
          ? t('app.common.offline')
          : t('app.common.error'),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div class="screen">
      <header class="lobby-head">
        <GroupAvatar group={data.group} size={56} />
        <div class="grow">
          <h1 class="title">{data.group.title}</h1>
          <p class="subtitle">
            {t('app.lobby.active_count', { count: data.active.length })} ·{' '}
            <span class="move-text">{t('app.lobby.your_move_count', { count: waiting })}</span>
          </p>
        </div>
        {data.isAdmin ? (
          <button
            class="icon-btn"
            data-action="group-settings"
            aria-label={t('app.lobby.settings')}
            onClick={() => router.push({ name: 'groupSettings', groupId: props.groupId })}
          >
            <svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d={GEAR_PATH} />
            </svg>
          </button>
        ) : null}
      </header>
      {data.players.length > 0 ? (
        <button
          class="chip-row"
          data-action="leaderboard"
          onClick={() => router.push({ name: 'leaderboard', groupId: props.groupId })}
        >
          {ranked ? <span class="rank">{t('app.lobby.rank', { rank: ranked.rank })}</span> : null}
          <span class="grow">
            <span class="primary">
              {ranked
                ? t('app.lobby.leaderboard_rating', {
                    rating: ratingLabel(ranked.entry.rating, ranked.entry.provisional),
                  })
                : t('app.lobby.leaderboard')}
            </span>
            <span class="secondary">
              {ranked
                ? t('app.lobby.rank_detail', {
                    record: t('app.player.record', ranked.entry.record),
                    players: rankedPlayers,
                  })
                : rankedPlayers}
            </span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
      ) : null}
      <button
        class="btn block"
        data-action="new-game"
        onClick={() => router.push({ name: 'newGame', groupId: props.groupId })}
      >
        {t('app.lobby.new_game')}
      </button>
      {data.challenges.length > 0 ? (
        <>
          <div class="section">
            {t('app.lobby.challenges_count', { count: data.challenges.length })}
          </div>
          <div class="card">
            {data.challenges.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                viewerId={viewerId}
                onAccept={(id) => void accept(id)}
                onDecline={(id) => void act(`/api/challenges/${id}/decline`, lobby.reload)}
                onCancel={(id) => void act(`/api/challenges/${id}/cancel`, lobby.reload)}
              />
            ))}
          </div>
        </>
      ) : null}
      <div class="games-head">
        <h2>{t('app.lobby.games')}</h2>
        <Segmented
          compact
          value={scope}
          onChange={setScope}
          options={[
            { value: 'mine', label: t('app.lobby.scope.mine'), 'data-scope': 'mine' },
            { value: 'others', label: t('app.lobby.scope.others'), 'data-scope': 'others' },
          ]}
        />
      </div>
      <div class="section">{t('app.lobby.active')}</div>
      {active.length === 0 ? (
        <div class="card empty">
          {t(scope === 'mine' ? 'app.lobby.no_active_mine' : 'app.lobby.no_active_others')}
        </div>
      ) : (
        <div class="card">
          {active.map((game) => (
            <GameCard key={game.id} game={game} dim="finished" onOpen={openGame} />
          ))}
        </div>
      )}
      <div class="section">{t('app.lobby.finished')}</div>
      {finished.length > 0 ? (
        <div class="card">
          {finished.map((game) => (
            <GameCard key={game.id} game={game} dim="finished" onOpen={openGame} />
          ))}
        </div>
      ) : data.finished.nextCursor === null ? (
        <div class="card empty">
          {t(scope === 'mine' ? 'app.lobby.no_finished_mine' : 'app.lobby.no_finished_others')}
        </div>
      ) : null}
      {data.finished.nextCursor ? (
        <button
          class="btn secondary block"
          data-action="more"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {t('app.common.more')}
        </button>
      ) : null}
    </div>
  );
}
