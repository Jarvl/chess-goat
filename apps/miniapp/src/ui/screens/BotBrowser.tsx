import { t } from '@chess-goat/shared';

/** Placeholder until the screen is built. */
export function BotBrowser(_props: { groupId: string }) {
  return (
    <div class="screen">
      <h1 class="title">{t('app.bot_browser.title')}</h1>
      <div class="hint">{t('app.common.loading')}</div>
    </div>
  );
}
