import { t, type OwnerRunnerDto } from '@chess-goat/shared';
import { ApiError } from '../api/client';
import { useState } from 'preact/hooks';
import { useApp } from './context';
import { confirmDialog } from './dialog';
import { dateLabel } from './format';
import { toast } from './toast';

function summary(runner: OwnerRunnerDto): string {
  const status = runner.connected
    ? t('app.bots.runner_connected')
    : runner.lastSeenAt
      ? t('app.bots.runner_last_seen', { date: dateLabel(runner.lastSeenAt) })
      : t('app.bots.runner_never');
  const bots = runner.bots === 'all' ? t('app.bots.runner_all_bots') : runner.bots.join(', ');
  return `${status} · ${bots}`;
}

/** The owner's runners, each revocable so a lost machine can be cut off. Linking is the agent's job. */
export function RunnersCard(props: { runners: OwnerRunnerDto[]; onRevoked: (id: number) => void }) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  // One revoke at a time: while it is confirming or in flight, every button is disabled.
  const revoke = async (runner: OwnerRunnerDto) => {
    if (busy) return;
    setBusy(true);
    try {
      const message = t('app.bots.runner_revoke_confirm', { label: runner.label });
      if (!(await confirmDialog(message, { danger: true }))) return;
      try {
        await client.del(`/api/me/runners/${runner.id}`);
      } catch (error) {
        // Already revoked elsewhere: the goal is met.
        if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
      }
      props.onRevoked(runner.id);
      toast(t('app.bots.runner_revoked'));
    } catch {
      toast(t('app.common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card" data-card="runners">
      <div class="field">
        <span class="grow">
          <span class="primary">{t('app.bots.runners')}</span>
          <span class="secondary">{t('app.bots.runners_hint')}</span>
        </span>
      </div>
      {props.runners.map((runner) => (
        <div key={runner.id} class="field" data-runner={runner.id}>
          <span class="grow">
            <span class="primary">{runner.label}</span>
            <span class="secondary">{summary(runner)}</span>
          </span>
          <button
            class="btn danger"
            data-action="revoke-runner"
            aria-label={t('app.bots.runner_revoke_label', { label: runner.label })}
            disabled={busy}
            onClick={() => void revoke(runner)}
          >
            {t('app.bots.runner_revoke')}
          </button>
        </div>
      ))}
    </div>
  );
}
