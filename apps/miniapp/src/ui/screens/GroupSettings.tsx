import {
  GroupSettingsDtoSchema,
  LobbyDtoSchema,
  t,
  TIME_PER_MOVE_OPTIONS,
  timeSpanLabel,
  type GameSummary,
  type GroupSettings as Settings,
  type TimePerMove,
} from '@chess-goat/shared';
import { useMemo, useState } from 'preact/hooks';
import { Avatar } from '../Avatar';
import { useApp } from '../context';
import { Field, Segmented, Switch, Tiles } from '../controls';
import { confirmDialog } from '../dialog';
import { playerLabel, summaryTitle } from '../format';
import { useMainButton, useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

function changed(base: Settings, draft: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of Object.keys(draft) as (keyof Settings)[]) {
    if (draft[key] !== base[key]) (patch as Record<string, unknown>)[key] = draft[key];
  }
  return patch;
}

export function GroupSettings(props: { groupId: string }) {
  const { client, prefetched } = useApp();
  const initial = prefetched.settings?.group.id === props.groupId ? prefetched.settings : undefined;
  if (initial) delete prefetched.settings;
  const settings = useResource(
    `gsettings:${props.groupId}`,
    () => client.get(`/api/groups/${props.groupId}/settings`, GroupSettingsDtoSchema),
    initial,
  );
  const lobby = useResource(`lobby:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const base = settings.data?.settings ?? null;
  const current = draft ?? base;
  const patch = base && current ? changed(base, current) : {};
  const valid = current
    ? current.cardTopicMode === 'origin' || (current.fixedTopicId ?? 0) > 0
    : false;
  const dirty = Object.keys(patch).length > 0;

  const save = useMemo(
    () => async () => {
      if (!dirty || !valid) return;
      setSaving(true);
      try {
        const updated = await client.put(
          `/api/groups/${props.groupId}/settings`,
          patch,
          GroupSettingsDtoSchema,
        );
        settings.set(updated);
        setDraft(null);
        toast(t('app.common.saved'));
      } catch {
        toast(t('app.common.error'));
      } finally {
        setSaving(false);
      }
    },
    [client, props.groupId, patch, dirty, valid, settings],
  );
  const inPage = useMainButton(
    dirty
      ? {
          text: t('app.common.save'),
          onClick: () => void save(),
          enabled: valid && !saving,
          progress: saving,
        }
      : null,
  );

  if (settings.error) return <ErrorScreen onRetry={() => void settings.reload()} />;
  if (!settings.data || !current) return <Loading />;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft({ ...current, [key]: value });

  const unblock = async (userId: string) => {
    await client.del(`/api/groups/${props.groupId}/blocks/${userId}`);
    await settings.reload();
  };
  const block = async (userId: string, name: string) => {
    if (!(await confirmDialog(t('app.gsettings.block_confirm', { name }), { danger: true })))
      return;
    await client.post(`/api/groups/${props.groupId}/blocks`, { userId });
    await settings.reload();
  };
  const voidGame = async (game: GameSummary) => {
    if (
      !(await confirmDialog(t('app.game.void_confirm'), {
        confirmLabel: t('app.game.void'),
        danger: true,
      }))
    )
      return;
    await client.post(`/api/games/${game.id}/void`, {});
    toast(t('app.game.voided'));
    await lobby.reload();
  };
  const blockedIds = new Set(settings.data.blocked.map((player) => player.id));
  const candidates = (lobby.data?.players ?? []).filter((player) => !blockedIds.has(player.id));
  const games = [...(lobby.data?.active ?? []), ...(lobby.data?.finished.items ?? [])].filter(
    (game) => !game.voided,
  );

  return (
    <div class="screen">
      <div>
        <h1 class="title">{t('app.gsettings.title')}</h1>
        <p class="subtitle">{settings.data.group.title}</p>
      </div>
      <div class="card">
        <div class="field column" data-setting="defaultTimePerMove">
          <span>{t('app.gsettings.default_time')}</span>
          <Tiles
            columns={3}
            value={current.defaultTimePerMove}
            onChange={(value) => set('defaultTimePerMove', value)}
            tiles={[...TIME_PER_MOVE_OPTIONS, null].map((value) => ({
              key: String(value),
              value: value as TimePerMove,
              label: value === null ? t('time.per_move.none') : timeSpanLabel(value),
              'data-time': value === null ? 'none' : value,
            }))}
          />
        </div>
        <div class="field">
          <span>{t('app.gsettings.rated_default')}</span>
          <Switch
            checked={current.ratedDefault}
            onChange={(value) => set('ratedDefault', value)}
            data-setting="ratedDefault"
          />
        </div>
        <div class="field">
          <span>{t('app.gsettings.open')}</span>
          <Switch
            checked={current.allowOpenChallenges}
            onChange={(value) => set('allowOpenChallenges', value)}
            data-setting="allowOpenChallenges"
          />
        </div>
        {settings.data.isForum ? (
          <>
            <div class="field">
              <span>{t('app.gsettings.topic')}</span>
              <Segmented
                value={current.cardTopicMode}
                onChange={(value) => set('cardTopicMode', value)}
                options={[
                  {
                    value: 'origin',
                    label: t('app.gsettings.topic.origin'),
                    'data-topic': 'origin',
                  },
                  { value: 'fixed', label: t('app.gsettings.topic.fixed'), 'data-topic': 'fixed' },
                ]}
              />
            </div>
            {current.cardTopicMode === 'fixed' ? (
              <Field label={t('app.gsettings.topic_id')}>
                <input
                  type="number"
                  min={1}
                  data-setting="fixedTopicId"
                  value={current.fixedTopicId ?? ''}
                  onInput={(event) =>
                    set('fixedTopicId', Number(event.currentTarget.value) || null)
                  }
                />
              </Field>
            ) : null}
          </>
        ) : null}
      </div>
      {inPage && dirty ? (
        <button class="btn block" disabled={!valid || saving} onClick={() => void save()}>
          {t('app.common.save')}
        </button>
      ) : null}
      <div class="section">{t('app.gsettings.blocked')}</div>
      <div class="card">
        {settings.data.blocked.length === 0 ? (
          <p class="row hint">{t('app.gsettings.none_blocked')}</p>
        ) : null}
        {settings.data.blocked.map((player) => (
          <div class="row" key={player.id}>
            <Avatar player={player} size={40} />
            <span class="grow primary">{playerLabel(player)}</span>
            <button
              class="pill-btn"
              data-unblock={player.id}
              onClick={() => void unblock(player.id)}
            >
              {t('app.gsettings.unblock')}
            </button>
          </div>
        ))}
      </div>
      <div class="section">{t('app.gsettings.block')}</div>
      <div class="card">
        {candidates.map((player) => (
          <div class="row" key={player.id}>
            <Avatar player={player} size={40} />
            <span class="grow primary">{playerLabel(player)}</span>
            <button
              class="pill-btn danger"
              data-block={player.id}
              onClick={() => void block(player.id, player.name)}
            >
              {t('app.gsettings.block')}
            </button>
          </div>
        ))}
      </div>
      <div class="section">{t('app.gsettings.void')}</div>
      <div class="card">
        {games.map((game) => (
          <div class="row" key={game.id}>
            <span class="grow primary">{summaryTitle(game)}</span>
            <button class="pill-btn danger" data-void={game.id} onClick={() => void voidGame(game)}>
              {t('app.game.void')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
