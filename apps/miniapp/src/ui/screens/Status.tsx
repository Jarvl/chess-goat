import { t, type GroupRef } from '@chess-goat/shared';
import { BRAND } from '../../brand';
import { useApp } from '../context';

export function Loading() {
  return <div class="screen centered hint">{t('app.common.loading')}</div>;
}

export function ErrorScreen(props: { onRetry?: () => void }) {
  return (
    <div class="screen centered">
      <img class="status-mark" src={BRAND.markUrl} alt="" width={72} height={72} />
      <p>{t('app.common.error')}</p>
      {props.onRetry ? (
        <button class="btn" onClick={props.onRetry}>
          {t('app.common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function Reopen() {
  const { tg } = useApp();
  return (
    <div class="screen centered">
      <img class="status-mark" src={BRAND.markUrl} alt="" width={72} height={72} />
      <h1 class="title">{t('app.reopen.title')}</h1>
      <p class="hint">{t('app.reopen.body')}</p>
      <button class="btn" onClick={() => tg.close()}>
        {t('app.common.close')}
      </button>
    </div>
  );
}

export function Locked(props: { group: GroupRef }) {
  const { tg } = useApp();
  return (
    <div class="screen centered">
      <img class="status-mark" src={BRAND.markUrl} alt="" width={72} height={72} />
      <h1 class="title">{t('app.locked.title')}</h1>
      <p>{props.group.title}</p>
      <p class="hint">{t('locked.hint')}</p>
      <button class="btn" onClick={() => tg.close()}>
        {t('app.common.close')}
      </button>
    </div>
  );
}
