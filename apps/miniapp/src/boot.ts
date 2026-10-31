import type { LaunchRoute } from '@chess-goat/shared';
import { launch } from './api/launch';
import type { Route, TabName } from './router';
import { applyLaunch } from './state/session';
import { applyChrome, applyTheme } from './tg/theme';
import type { AppContextValue, Prefetched } from './ui/context';

/**
 * Maps the launch route to a tab and its one screen, parking that screen's data for its first
 * render. Every landing is one deep, New game aside: the tab bar carries "go home", so the
 * BackButton is free to mean "leave", which is what a launch from a chat card wants it to mean.
 */
export function landingFor(
  route: LaunchRoute,
  prefetched: Prefetched,
): { tab: TabName; route: Route; below?: Route[] } {
  switch (route.kind) {
    case 'game':
      prefetched.game = route.game;
      return { tab: 'games', route: { name: 'game', gameId: route.game.id } };
    case 'lobby':
      prefetched.lobby = route.lobby;
      return { tab: 'groups', route: { name: 'lobby', groupId: route.lobby.group.id } };
    case 'newGame':
      // Back from a chat's "challenge someone" link leads to the group before it closes.
      prefetched.lobby = route.lobby;
      return {
        tab: 'groups',
        route: { name: 'newGame', groupId: route.lobby.group.id },
        below: [{ name: 'lobby', groupId: route.lobby.group.id }],
      };
    case 'settings':
      prefetched.settings = route.settings;
      return { tab: 'groups', route: { name: 'groupSettings', groupId: route.settings.group.id } };
    case 'home':
      prefetched.games = route.games;
      return { tab: 'games', route: { name: 'games' } };
    case 'locked':
      return { tab: 'groups', route: { name: 'locked', group: route.group } };
  }
}

/** Spec §6.1 steps 1–4: prepare the client, launch once, land, then ask for write access. */
export async function boot(app: AppContextValue): Promise<void> {
  const { tg, client, router, prefetched } = app;
  applyTheme(tg);
  applyChrome(tg);
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes();
  tg.onThemeChanged(() => {
    applyTheme(tg);
    applyChrome(tg);
  });
  tg.onViewportChanged(() => applyTheme(tg));

  const outcome = await launch(client, tg.initData);
  if (outcome.kind === 'expired') {
    router.land('games', { name: 'reopen' });
    return;
  }
  if (outcome.kind === 'failed') {
    router.land('games', { name: 'error' });
    return;
  }
  applyLaunch(outcome.response, tg.startParam);
  const landing = landingFor(outcome.response.route, prefetched);
  router.land(landing.tab, landing.route, landing.below);

  // Telegram's ⋯ menu gains Settings once there is a session to have settings for.
  tg.onSettingsButton(() => router.select('settings'));

  if (outcome.response.askWriteAccess && tg.supports('writeAccess')) {
    setTimeout(() => {
      void tg.requestWriteAccess().then(async (granted) => {
        if (granted === null) return;
        await client
          .put('/api/me/prefs', { writeAccess: { allowed: granted } })
          .catch(() => undefined);
      });
    }, 0);
  }
}

/** The 401 path of spec §6.1 step 6: one relaunch with the original initData, or the reopen screen. */
export async function relaunch(app: AppContextValue): Promise<string | null> {
  const outcome = await launch(app.client, app.tg.initData);
  if (outcome.kind === 'ok') return outcome.response.token;
  app.router.land('games', { name: 'reopen' });
  return null;
}
