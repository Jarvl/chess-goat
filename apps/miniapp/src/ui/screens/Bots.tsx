import {
  OwnerBotsDtoSchema,
  OwnerTokenCreatedDtoSchema,
  OwnerTokenStatusDtoSchema,
  ratingLabel,
  t,
  type OwnerBotDto,
  type OwnerTokenStatusDto,
} from '@chess-goat/shared';
import { useEffect, useState } from 'preact/hooks';
import { session } from '../../state/session';
import { useApp } from '../context';
import { confirmDialog } from '../dialog';
import { GameCard } from '../GameCard';
import { dateLabel } from '../format';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

type Info = OwnerTokenStatusDto['token'];

function BotCard(props: { bot: OwnerBotDto }) {
  const { router } = useApp();
  const { bot } = props;
  return (
    <div class="card" data-bot={bot.id}>
      <div class="field">
        <span class="grow">
          <span class="primary">{bot.label}</span>
          {bot.tagline ? <span class="secondary">{bot.tagline}</span> : null}
          {bot.liveGames > 0 ? (
            <span class="secondary">
              {t(bot.liveGames === 1 ? 'app.bots.live_games_one' : 'app.bots.live_games', {
                count: bot.liveGames,
              })}
            </span>
          ) : null}
          {bot.groups.length > 0 ? (
            <span class="secondary">
              {t(bot.groups.length === 1 ? 'app.bots.groups_one' : 'app.bots.groups', {
                count: bot.groups.length,
              })}
            </span>
          ) : null}
        </span>
      </div>
      {bot.groups.map((group) => {
        const content = (
          <>
            <span class="grow">
              <span class="primary">{group.title}</span>
            </span>
            <span class="secondary">{ratingLabel(group.rating, group.provisional)}</span>
          </>
        );
        // A group the owner has left keeps its row, but its pages are no longer theirs to open.
        return group.ownerIsMember ? (
          <button
            key={group.groupId}
            class="field"
            data-bot-group={group.groupId}
            onClick={() =>
              router.push({ name: 'player', groupId: group.groupId, userId: String(bot.id) })
            }
          >
            {content}
          </button>
        ) : (
          <div key={group.groupId} class="field" data-bot-group={group.groupId}>
            {content}
          </div>
        );
      })}
      {bot.recent.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          dim="finished"
          onOpen={(gameId) => router.push({ name: 'game', gameId })}
        />
      ))}
    </div>
  );
}

export function Bots() {
  const { client } = useApp();
  const [bots, setBots] = useState<OwnerBotDto[] | undefined>(undefined);
  const [botsFailed, setBotsFailed] = useState(false);
  const [info, setInfo] = useState<Info | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  // The plaintext token lives only here: shown once, gone when the screen closes.
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setFailed(false);
    client
      .get('/api/me/owner-token', OwnerTokenStatusDtoSchema)
      .then((status) => setInfo(status.token))
      .catch(() => setFailed(true));
  };
  useEffect(load, [client]);
  // The list is an extra: if it will not load, the token card still works.
  const loadBots = () => {
    setBotsFailed(false);
    client
      .get('/api/me/bots', OwnerBotsDtoSchema)
      .then((list) => setBots(list.bots))
      .catch(() => setBotsFailed(true));
  };
  useEffect(loadBots, [client]);

  const create = async (confirmMessage?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (confirmMessage && !(await confirmDialog(confirmMessage, { danger: true }))) return;
      const created = await client.post(
        '/api/me/owner-token',
        undefined,
        OwnerTokenCreatedDtoSchema,
      );
      setSecret(created.token);
      setInfo({ createdAt: created.createdAt, lastUsedAt: null });
    } catch {
      toast(t('app.common.error'));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await confirmDialog(t('app.bots.revoke_confirm'), { danger: true }))) return;
      await client.del('/api/me/owner-token');
      setSecret(null);
      setInfo(null);
    } catch {
      toast(t('app.common.error'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? '');
      toast(t('app.bots.copied'));
    } catch {
      toast(t('app.common.error'));
    }
  };

  if (failed) return <ErrorScreen onRetry={load} />;
  if (info === undefined) return <Loading />;
  return (
    <div class="screen">
      <h1 class="title">{t('app.bots.title')}</h1>
      {botsFailed ? (
        <div class="card empty" data-bots-failed>
          {t('app.bots.load_failed')}
          <button class="btn" data-action="retry-bots" onClick={loadBots}>
            {t('app.common.retry')}
          </button>
        </div>
      ) : bots === undefined ? null : (
        <>
          {bots.length === 0 ? (
            <div class="card empty" data-bots-empty>
              {t('app.bots.none_yet')}
            </div>
          ) : (
            bots.map((bot) => <BotCard key={bot.id} bot={bot} />)
          )}
        </>
      )}
      <p class="hint">{t('app.bots.intro', { url: session.value?.bot.mcpUrl ?? '' })}</p>
      <div class="card" data-card="owner-token">
        <div class="field">
          <span class="grow">
            <span class="primary">{t('app.bots.token')}</span>
            {info ? (
              <>
                <span class="secondary">
                  {t('app.bots.token_created', { date: dateLabel(info.createdAt) })}
                </span>
                <span class="secondary">
                  {info.lastUsedAt
                    ? t('app.bots.token_last_used', { date: dateLabel(info.lastUsedAt) })
                    : t('app.bots.token_never_used')}
                </span>
              </>
            ) : (
              <span class="secondary">{t('app.bots.token_none')}</span>
            )}
          </span>
        </div>
        {secret ? (
          <div class="field">
            <span class="grow">
              <code class="token" data-token>
                {secret}
              </code>
              <span class="secondary">{t('app.bots.shown_once')}</span>
            </span>
            <button class="btn" data-action="copy-token" onClick={() => void copy()}>
              {t('app.bots.copy')}
            </button>
          </div>
        ) : null}
      </div>
      <p class="hint">{t('app.bots.warning')}</p>
      {info ? (
        <>
          <button
            class="btn secondary block"
            data-action="rotate-token"
            disabled={busy}
            onClick={() => void create(t('app.bots.rotate_confirm'))}
          >
            {t('app.bots.rotate')}
          </button>
          <button
            class="card danger-row"
            data-action="revoke-token"
            disabled={busy}
            onClick={() => void revoke()}
          >
            {t('app.bots.revoke')}
          </button>
        </>
      ) : (
        <button
          class="btn block"
          data-action="create-token"
          disabled={busy}
          onClick={() => void create()}
        >
          {t('app.bots.create')}
        </button>
      )}
    </div>
  );
}
