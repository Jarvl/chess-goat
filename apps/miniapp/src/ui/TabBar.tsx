import { t, type MessageKey } from '@chess-goat/shared';
import type { JSX } from 'preact';
import { TABS, type TabName } from '../router';
import { yourMoveCount } from '../state/yourMove';
import { useApp } from './context';
import { GEAR_PATH } from './icons';

const TAB_LABEL: Record<TabName, MessageKey> = {
  games: 'app.nav.games',
  groups: 'app.nav.groups',
  settings: 'app.nav.settings',
};

/** Drawn, not lettered: an emoji glyph carries its own colour and would not dim when inactive. */
const TAB_ICON: Record<TabName, JSX.Element> = {
  games: (
    <>
      <path d="M12 3a2.6 2.6 0 0 0-1.5 4.75C9.5 8.4 9 9.4 9 10.5c0 1 .4 1.9 1 2.5-.9 1.6-1.5 3.4-1.7 5h7.4c-.2-1.6-.8-3.4-1.7-5 .6-.6 1-1.5 1-2.5 0-1.1-.5-2.1-1.5-2.75A2.6 2.6 0 0 0 12 3Z" />
      <path d="M6.5 19.5h11a1 1 0 0 1 1 1V22h-13v-1.5a1 1 0 0 1 1-1Z" />
    </>
  ),
  groups: (
    <>
      <circle cx="9" cy="7.8" r="3.2" />
      <circle cx="16.6" cy="8.5" r="2.5" />
      <path d="M9 12.6c-3 0-5.5 1.6-5.5 3.6V19h11v-2.8c0-2-2.5-3.6-5.5-3.6Z" />
      <path d="M16.6 12.8c-.8 0-1.5.1-2.2.4 1.3.9 2.1 2.1 2.1 3.4V19H21v-2.5c0-1.9-1.9-3.4-4.4-3.7Z" />
    </>
  ),
  settings: <path fill-rule="evenodd" d={GEAR_PATH} />,
};

/**
 * The lateral navigation: one tap to any section from anywhere, so depth never has to be
 * spent on getting home and the BackButton is left free to mean "leave".
 */
export function TabBar() {
  const { router, tg } = useApp();
  if (!router.showTabs.value) return null;
  const active = router.tab.value;
  // Only Games carries a count, and only while something is actually waiting: a zero badge is
  // noise on a bar the viewer sees on every screen.
  const waiting = yourMoveCount.value;
  return (
    <nav class="tabbar" role="tablist" aria-label={t('app.nav.label')}>
      {TABS.map((tab) => {
        const badge = tab === 'games' && waiting > 0 ? waiting : null;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            class={tab === active ? 'nav-item active' : 'nav-item'}
            aria-selected={tab === active}
            aria-label={badge === null ? undefined : t('app.nav.games_waiting', { count: badge })}
            data-nav={tab}
            onClick={() => {
              tg.hapticSelection();
              router.select(tab);
            }}
          >
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                {TAB_ICON[tab]}
              </svg>
              {badge === null ? null : (
                <span class="nav-badge" data-badge={badge} aria-hidden="true">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span class="nav-label">{t(TAB_LABEL[tab])}</span>
          </button>
        );
      })}
    </nav>
  );
}
