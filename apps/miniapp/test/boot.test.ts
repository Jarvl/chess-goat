import { GROUP_SETTINGS_DEFAULTS } from '@group-chess/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { boot } from '../src/boot';
import { Router } from '../src/router';
import { prefs, session } from '../src/state/session';
import { setYourMoveCount, yourMoveCount } from '../src/state/yourMove';
import { ACCENTS } from '../src/tg/theme';
import { createTg } from '../src/tg/webapp';
import type { Prefetched } from '../src/ui/context';
import { fakeFetch } from './support/fakeFetch';
import { installFakeWebApp } from './support/fakeWebApp';
import { gameDto } from './support/gameFixtures';

const launchBody = (route: unknown, askWriteAccess = false, yourMove = 0) => ({
  token: 'jwt',
  user: { id: '1', name: 'Alice', username: 'alice' },
  prefs: {
    notifications: true,
    moveConfirmations: 'people',
    boardTheme: null,
    pieceSet: null,
  },
  askWriteAccess,
  yourMove,
  route,
  serverTime: new Date().toISOString(),
  bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
});

function setup(
  version: string,
  startParam: string | undefined,
  handler: Parameters<typeof fakeFetch>[0],
  writeAccess = true,
) {
  installFakeWebApp({ version, initData: 'user=x&hash=y', startParam, writeAccess });
  const tg = createTg(window.Telegram!.WebApp);
  const { fetch, calls } = fakeFetch(handler);
  const client = createApiClient({ fetch });
  const router = new Router(tg, { closeFromRoot: startParam !== undefined });
  const prefetched: Prefetched = {};
  return { tg, client, router, prefetched, calls, record: window.__tg! };
}

describe('boot', () => {
  it('launches once, lands on the resolved route with its data and asks for write access afterwards', async () => {
    const game = gameDto();
    const { tg, client, router, prefetched, calls, record } = setup(
      '8.0',
      'g_AbCdEfGhIj',
      ({ path }) =>
        path === '/api/launch'
          ? { status: 200, body: launchBody({ kind: 'game', game }, true) }
          : { status: 200, body: { prefs: prefs.value, dmAllowed: true } },
    );
    await boot({ tg, client, router, prefetched });
    // One screen deep in the Games tab: the tab bar is the way home, back is the way out.
    expect(router.tab.value).toBe('games');
    expect(router.stack.value).toEqual([{ name: 'game', gameId: 'AbCdEfGhIj' }]);
    expect(record.backButton.visible).toBe(true);
    expect(prefetched.game?.id).toBe('AbCdEfGhIj');
    expect(session.value?.launchedFrom).toEqual({ kind: 'game', gameId: 'AbCdEfGhIj' });
    expect(
      record.calls.filter((c) => c === 'ready' || c === 'expand' || c === 'disableVerticalSwipes'),
    ).toEqual(['ready', 'expand', 'disableVerticalSwipes']);
    expect(record.chrome).toEqual({
      header: 'secondary_bg_color',
      background: 'secondary_bg_color',
      bottomBar: 'secondary_bg_color',
    });
    expect(record.mainButton.color).toBe(ACCENTS.light['--acc']);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(record.calls).toContain('requestWriteAccess');
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/api/launch'],
      ['PUT', '/api/me/prefs'],
    ]);
    expect(calls[1]?.body).toEqual({ writeAccess: { allowed: true } });
    // Telegram's own ⋯ menu gets a Settings entry that opens the Settings tab.
    expect(record.settingsButton?.visible).toBe(true);
    record.clickSettings();
    expect(router.tab.value).toBe('settings');
  });

  it('records a declined write-access prompt too', async () => {
    const { tg, client, router, prefetched, calls } = setup(
      '8.0',
      undefined,
      ({ path }) =>
        path === '/api/launch'
          ? { status: 200, body: launchBody({ kind: 'home', games: { items: [] } }, true) }
          : { status: 200, body: { prefs: prefs.value, dmAllowed: false } },
      false,
    );
    await boot({ tg, client, router, prefetched });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/api/launch'],
      ['PUT', '/api/me/prefs'],
    ]);
    expect(calls[1]?.body).toEqual({ writeAccess: { allowed: false } });
  });

  it("skips the write-access prompt on old clients and lands on the group's lobby", async () => {
    const lobby = {
      group: { id: 'GrOuPiDxYz', title: 'Club' },
      isAdmin: false,
      settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
      active: [],
      finished: { items: [], nextCursor: null },
      challenges: [],
      players: [],
    };
    const { tg, client, router, prefetched, calls } = setup('6.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'lobby', lobby }, true),
    }));
    await boot({ tg, client, router, prefetched });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.tab.value).toBe('groups');
    expect(router.stack.value).toEqual([{ name: 'lobby', groupId: 'GrOuPiDxYz' }]);
    // No write-access answer is sent (the wait above gives one the time to arrive); that the
    // prompt itself never opened is the global check's.
    expect(calls).toHaveLength(1);
  });

  it('lands a challenge link on New game over the prefetched lobby', async () => {
    const lobby = {
      group: { id: 'GrOuPiDxYz', title: 'Club' },
      isAdmin: false,
      settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
      active: [],
      finished: { items: [], nextCursor: null },
      challenges: [],
      players: [],
    };
    const app = setup('8.0', 'n_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'newGame', lobby }),
    }));
    await boot(app);
    expect(app.router.tab.value).toBe('groups');
    expect(app.router.stack.value).toEqual([
      { name: 'lobby', groupId: 'GrOuPiDxYz' },
      { name: 'newGame', groupId: 'GrOuPiDxYz' },
    ]);
    expect(app.prefetched.lobby).toEqual(lobby);
  });

  it('shows the reopen screen when the launch is rejected and the error screen when it fails', async () => {
    const expired = setup('8.0', undefined, () => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'stale' } },
    }));
    await boot(expired);
    expect(expired.router.current.value).toEqual({ name: 'reopen' });

    const broken = setup('8.0', undefined, ({ path }) =>
      path === '/api/launch' ? { status: 503 } : { status: 200, body: { ok: true } },
    );
    await boot(broken);
    expect(broken.router.current.value).toEqual({ name: 'error' });
  });

  it('lands a profile launch on the games home with its games prefetched', async () => {
    const home = setup('8.0', undefined, () => ({
      status: 200,
      body: launchBody({ kind: 'home', games: { items: [] } }),
    }));
    await boot(home);
    expect(home.router.tab.value).toBe('games');
    expect(home.router.stack.value).toEqual([{ name: 'games' }]);
    expect(home.prefetched.games).toEqual({ items: [] });
    expect(home.record.backButton.visible).toBe(false);
  });

  it('lands a group-settings launch in the groups tab', async () => {
    const settings = {
      group: { id: 'GrOuPiDxYz', title: 'Club' },
      settings: GROUP_SETTINGS_DEFAULTS,
      blocked: [],
      botIsAdmin: true,
      isForum: false,
    };
    const app = setup('8.0', 's_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'settings', settings }),
    }));
    await boot(app);
    expect(app.router.tab.value).toBe('groups');
    expect(app.router.stack.value).toEqual([{ name: 'groupSettings', groupId: 'GrOuPiDxYz' }]);
  });

  it('seeds the Games badge from the launch, so a deep link shows the real total', async () => {
    setYourMoveCount(0);
    const game = gameDto();
    const app = setup('8.0', 'g_AbCdEfGhIj', () => ({
      status: 200,
      body: launchBody({ kind: 'game', game }, false, 4),
    }));
    await boot(app);
    // The launch landed on one game, but the badge counts every group the viewer can see.
    expect(yourMoveCount.value).toBe(4);
  });

  it('routes a locked launch to the locked screen', async () => {
    const locked = setup('8.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } }),
    }));
    await boot(locked);
    expect(locked.router.current.value).toEqual({
      name: 'locked',
      group: { id: 'GrOuPiDxYz', title: 'Club' },
    });
  });

  it('follows Telegram from light to dark without a reload', async () => {
    const { tg, client, router, prefetched, record } = setup('8.0', undefined, () => ({
      status: 200,
      body: launchBody({ kind: 'home', games: { items: [] } }),
    }));
    await boot({ tg, client, router, prefetched });
    expect(document.documentElement.style.getPropertyValue('--acc')).toBe(ACCENTS.light['--acc']);
    (window.Telegram!.WebApp as { colorScheme: string }).colorScheme = 'dark';
    record.emit('themeChanged');
    expect(document.documentElement.style.getPropertyValue('--acc')).toBe(ACCENTS.dark['--acc']);
    expect(record.mainButton.color).toBe(ACCENTS.dark['--acc']);
  });
});
