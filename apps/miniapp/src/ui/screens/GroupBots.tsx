import { t } from '@chess-goat/shared';

/** Placeholder until the screen is built. */
export function GroupBots(_props: { groupId: string }) {
  return (
    <div class="screen">
      <h1 class="title">{t('app.group_bots.title')}</h1>
      <div class="hint">{t('app.common.loading')}</div>
    </div>
  );
}
