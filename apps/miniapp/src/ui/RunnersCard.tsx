import { t, type OwnerRunnerDto } from '@chess-goat/shared';
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
  const [busy, setBusy] = useState<number | null>(null);
  const revoke = async (id: number) => {
    if (busy !== null) return;
    setBusy(id);
    try {
      if (!(await confirmDialog(t('app.bots.runner_revoke_confirm'), { danger: true }))) return;
      await client.del(`/api/me/runners/${id}`);
      props.onRevoked(id);
      toast(t('app.bots.runner_revoked'));
    } catch {
      toast(t('app.common.error'));
    } finally {
      setBusy(null);
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
            disabled={busy === runner.id}
            onClick={() => void revoke(runner.id)}
          >
            {t('app.bots.runner_revoke')}
          </button>
        </div>
      ))}
    </div>
  );
}
