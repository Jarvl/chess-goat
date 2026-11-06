import {
  OwnerTokenCreatedDtoSchema,
  OwnerTokenStatusDtoSchema,
  t,
  type OwnerTokenStatusDto,
} from '@chess-goat/shared';
import { useEffect, useState } from 'preact/hooks';
import { session } from '../../state/session';
import { useApp } from '../context';
import { confirmDialog } from '../dialog';
import { dateLabel } from '../format';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

type Info = OwnerTokenStatusDto['token'];

export function Bots() {
  const { client } = useApp();
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
