import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@chess-goat/shared';
import { Bots } from '../src/ui/screens/Bots';
import type { FakeRoute } from './support/fakeFetch';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const TOKEN = 'cgbot_abc';
const CREATED = '2026-05-01T12:00:00.000Z';
const writeText = vi.fn();

const NO_BOTS = { bots: [] };

function server(
  initial: { createdAt: string; lastUsedAt: string | null } | null,
  list: unknown = NO_BOTS,
): FakeRoute {
  let state = initial;
  return ({ method, path }) => {
    if (path === '/api/me/bots') return { status: 200, body: list };
    if (path === '/api/me/runners' || path.startsWith('/api/me/runners/'))
      return { status: 404, body: { error: { code: 'not_found', message: 'none' } } };
    if (method === 'POST') {
      state = { createdAt: CREATED, lastUsedAt: null };
      return { status: 200, body: { token: TOKEN, createdAt: CREATED } };
    }
    if (method === 'DELETE') {
      state = null;
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { token: state } };
  };
}
const writes = (r: ReturnType<typeof renderApp>) => r.calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  document.querySelector('.toast')?.remove();
});

describe('Bots', () => {
  it('names the MCP URL in its intro', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    expect(r.root.textContent).toContain(t('app.bots.intro', { url: 'https://chess.test/mcp' }));
    expect(r.root.textContent).toContain('at https://chess.test/mcp with your owner token');
  });

  it('offers to create a token when there is none', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    expect(r.root.textContent).toContain(t('app.bots.token_none'));
    expect(r.root.textContent).toContain(t('app.bots.warning'));
    expect(r.root.querySelector('[data-action="create-token"]')).not.toBeNull();
  });

  it('shows a created token once and copies it', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    await r.click('[data-action="create-token"]');
    expect(writes(r)[0]).toMatchObject({ method: 'POST', path: '/api/me/owner-token' });
    expect(r.root.querySelector('[data-token]')?.textContent).toBe(TOKEN);
    expect(r.root.textContent).toContain(t('app.bots.shown_once'));
    await r.click('[data-action="copy-token"]');
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.bots.copied'));
  });

  it('toasts an error when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('no'));
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    await r.click('[data-action="create-token"]');
    await r.click('[data-action="copy-token"]');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });

  it('shows the dates of an existing token and confirms before replacing or revoking', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    expect(r.root.textContent).toContain('Created May 1, 2026');
    expect(r.root.textContent).toContain(t('app.bots.token_never_used'));
    await r.click('[data-action="rotate-token"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe(t('app.bots.rotate_confirm'));
    window.__tg!.answerPopup('cancel');
    await r.flush();
    await r.click('[data-action="revoke-token"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe(t('app.bots.revoke_confirm'));
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(writes(r)).toHaveLength(0);
  });

  it('shows the last use when there is one', async () => {
    const r = renderApp(
      () => <Bots />,
      server({ createdAt: CREATED, lastUsedAt: '2026-06-02T08:00:00.000Z' }),
    );
    await r.flush();
    expect(r.root.textContent).toContain('Last used Jun 2, 2026');
  });

  it('replaces a token after confirming', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    await r.click('[data-action="rotate-token"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({ method: 'POST', path: '/api/me/owner-token' });
    expect(r.root.querySelector('[data-token]')?.textContent).toBe(TOKEN);
  });

  it('revokes after confirming and returns to the none state', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    await r.click('[data-action="revoke-token"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({ method: 'DELETE', path: '/api/me/owner-token' });
    expect(r.root.textContent).toContain(t('app.bots.token_none'));
    expect(r.root.querySelector('[data-action="create-token"]')).not.toBeNull();
  });

  it('toasts an error when a request fails', async () => {
    const r = renderApp(
      () => <Bots />,
      ({ method, path }) =>
        path === '/api/me/bots'
          ? { status: 200, body: NO_BOTS }
          : method === 'GET'
            ? { status: 200, body: { token: null } }
            : { status: 500, body: { error: { code: 'internal', message: 'boom' } } },
    );
    await r.flush();
    await r.click('[data-action="create-token"]');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
    expect(r.root.querySelector('[data-token]')).toBeNull();
  });

  it('does not keep the token after leaving and reopening', async () => {
    const route = server(null);
    const first = renderApp(() => <Bots />, route);
    await first.flush();
    await first.click('[data-action="create-token"]');
    expect(first.root.querySelector('[data-token]')).not.toBeNull();
    const second = renderApp(() => <Bots />, route);
    await second.flush();
    expect(second.root.querySelector('[data-token]')).toBeNull();
    expect(second.root.textContent).not.toContain(TOKEN);
  });

  const rook = {
    id: 7,
    label: '🤖 Rook (@zed)',
    tagline: 'Pushes pawns',
    lastActiveAt: '2026-09-20T12:00:00.000Z',
    groups: [
      {
        groupId: 'GrOuPiDxYz',
        title: 'Chess club',
        rating: 1650,
        gamesPlayed: 4,
        provisional: false,
        ownerIsMember: true,
      },
      {
        groupId: 'OtHeRgRoUp',
        title: 'Other club',
        rating: 1500,
        gamesPlayed: 0,
        provisional: true,
        ownerIsMember: true,
      },
    ],
    liveGames: 2,
    recent: [
      gameSummary({
        id: 'DoneBbbbbb',
        status: 'finished',
        white: playerRef('7', '🤖 Rook (@zed)'),
        black: playerRef('8', '🤖 Pawn (@zed)'),
        yourTurn: false,
        result: '1-0',
        endReason: 'resignation',
        finishedAt: '2026-09-20T12:00:00.000Z',
      }),
    ],
  };

  it('says there are no bots yet, above the token card, under the one title', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    expect(r.root.querySelectorAll('.section')).toHaveLength(0);
    expect(r.text()).toContain(t('app.bots.none_yet'));
    const empty = r.root.querySelector('[data-bots-empty]')!;
    const token = r.root.querySelector('[data-card="owner-token"]')!;
    expect(empty.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists each bot with its live games, groups and recent games', async () => {
    const r = renderApp(() => <Bots />, server(null, { bots: [rook] }));
    await r.flush();
    const card = r.root.querySelector('[data-bot="7"]')!;
    expect(card.textContent).toContain('🤖 Rook (@zed)');
    expect(card.textContent).toContain('Pushes pawns');
    expect(card.textContent).toContain(t('app.bots.live_games', { count: 2 }));
    expect(card.textContent).toContain(t('app.bots.groups', { count: 2 }));
    expect(card.textContent).toContain('Chess club');
    expect(card.querySelector('[data-bot-group="GrOuPiDxYz"]')?.textContent).toContain('1650');
    expect(card.querySelector('[data-bot-group="GrOuPiDxYz"]')?.textContent).not.toContain('?');
    expect(card.querySelector('[data-bot-group="OtHeRgRoUp"]')?.textContent).toContain('1500?');
    expect(card.querySelector('[data-game="DoneBbbbbb"]')).not.toBeNull();
    expect(r.root.querySelector('[data-bots-empty]')).toBeNull();
  });

  it("opens the bot's profile from a group row", async () => {
    const r = renderApp(() => <Bots />, server(null, { bots: [rook] }));
    await r.flush();
    await r.click('[data-bot-group="OtHeRgRoUp"]');
    expect(r.app.router.current.value).toEqual({
      name: 'player',
      groupId: 'OtHeRgRoUp',
      userId: '7',
    });
  });

  it('shows a group the owner has left without a way into it', async () => {
    const left = { ...rook, groups: [{ ...rook.groups[1]!, ownerIsMember: false }] };
    const r = renderApp(() => <Bots />, server(null, { bots: [left] }));
    await r.flush();
    const row = r.root.querySelector('[data-bot-group="OtHeRgRoUp"]')!;
    expect(row.tagName).not.toBe('BUTTON');
    expect(row.textContent).toContain('Other club');
    await r.click('[data-bot-group="OtHeRgRoUp"]');
    expect(r.app.router.stack.value).toEqual([]);
  });

  it('opens a recent game', async () => {
    const r = renderApp(() => <Bots />, server(null, { bots: [rook] }));
    await r.flush();
    await r.click('[data-game="DoneBbbbbb"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'DoneBbbbbb' });
  });

  it('says the list failed, not that there are no bots, and retries', async () => {
    let fail = true;
    const base = server(null, { bots: [rook] });
    const r = renderApp(
      () => <Bots />,
      (req) =>
        req.path === '/api/me/bots' && fail
          ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
          : base(req),
    );
    await r.flush();
    expect(r.text()).toContain(t('app.bots.load_failed'));
    expect(r.text()).not.toContain(t('app.bots.none_yet'));
    expect(r.root.querySelector('[data-card="owner-token"]')).not.toBeNull();
    fail = false;
    await r.click('[data-action="retry-bots"]');
    expect(r.root.querySelector('[data-bot="7"]')).not.toBeNull();
    expect(r.root.querySelector('[data-bots-failed]')).toBeNull();
  });

  it('uses singular wording for one game and one group', async () => {
    const one = { ...rook, liveGames: 1, groups: [rook.groups[0]!] };
    const r = renderApp(() => <Bots />, server(null, { bots: [one] }));
    await r.flush();
    expect(r.text()).toContain('1 game in progress');
    expect(r.text()).toContain('In 1 group');
    expect(r.text()).not.toContain('In 1 groups');
  });

  describe('runners', () => {
    const connected = {
      id: 1,
      label: 'Laptop',
      harness: 'claude',
      bots: 'all',
      connected: true,
      lastSeenAt: '2026-05-02T12:00:00.000Z',
    };
    const never = {
      id: 2,
      label: 'Old desktop',
      harness: null,
      bots: ['Rook', 'Pawn'],
      connected: false,
      lastSeenAt: null,
    };
    function withRunners(list: unknown[], del: () => { status: number; body?: unknown }) {
      let runners = list;
      const base = server(null);
      return (req: Parameters<FakeRoute>[0]) => {
        if (req.path === '/api/me/runners') return { status: 200, body: { runners } };
        const match = /^\/api\/me\/runners\/(\d+)$/.exec(req.path);
        if (match && req.method === 'DELETE') {
          const res = del();
          if (res.status === 204)
            runners = runners.filter((x) => (x as { id: number }).id !== Number(match[1]));
          return res;
        }
        return base(req);
      };
    }
    const ok = () => ({ status: 204 });

    it('has no runners card without runners', async () => {
      const r = renderApp(() => <Bots />, withRunners([], ok));
      await r.flush();
      expect(r.root.querySelector('[data-card="runners"]')).toBeNull();
    });

    it('lists each runner with its status and bots', async () => {
      const r = renderApp(() => <Bots />, withRunners([connected, never], ok));
      await r.flush();
      const card = r.root.querySelector('[data-card="runners"]')!;
      expect(card.textContent).toContain(t('app.bots.runners'));
      expect(card.querySelector('[data-runner="1"]')!.textContent).toContain('Laptop');
      expect(card.querySelector('[data-runner="1"]')!.textContent).toContain(
        `${t('app.bots.runner_connected')} · ${t('app.bots.runner_all_bots')}`,
      );
      expect(card.querySelector('[data-runner="2"]')!.textContent).toContain(
        `${t('app.bots.runner_never')} · Rook, Pawn`,
      );
    });

    it('shows when a disconnected runner was last seen', async () => {
      const r = renderApp(() => <Bots />, withRunners([{ ...connected, connected: false }], ok));
      await r.flush();
      expect(r.root.querySelector('[data-runner="1"]')!.textContent).not.toContain(
        t('app.bots.runner_never'),
      );
      expect(r.root.querySelector('[data-runner="1"]')!.textContent).toContain('Last seen');
    });

    it('leaves the token card working when the runners fail to load', async () => {
      const r = renderApp(() => <Bots />, server(null));
      await r.flush();
      expect(r.root.querySelector('[data-card="runners"]')).toBeNull();
      expect(r.root.querySelector('[data-card="owner-token"]')).not.toBeNull();
    });

    it('revokes after confirming, then drops the row and the card', async () => {
      const r = renderApp(() => <Bots />, withRunners([connected], ok));
      await r.flush();
      await r.click('[data-runner="1"] [data-action="revoke-runner"]');
      window.__tg!.answerPopup('confirm');
      await r.flush();
      expect(writes(r)[0]).toMatchObject({ method: 'DELETE', path: '/api/me/runners/1' });
      expect(r.root.querySelector('[data-card="runners"]')).toBeNull();
      expect(document.querySelector('.toast')?.textContent).toContain(t('app.bots.runner_revoked'));
    });

    it('keeps the other rows when one is revoked', async () => {
      const r = renderApp(() => <Bots />, withRunners([connected, never], ok));
      await r.flush();
      await r.click('[data-runner="2"] [data-action="revoke-runner"]');
      window.__tg!.answerPopup('confirm');
      await r.flush();
      expect(r.root.querySelector('[data-runner="2"]')).toBeNull();
      expect(r.root.querySelector('[data-runner="1"]')).not.toBeNull();
    });

    it('sends nothing when the confirmation is declined', async () => {
      const r = renderApp(() => <Bots />, withRunners([connected], ok));
      await r.flush();
      await r.click('[data-action="revoke-runner"]');
      window.__tg!.answerPopup('cancel');
      await r.flush();
      expect(writes(r)).toEqual([]);
      expect(r.root.querySelector('[data-runner="1"]')).not.toBeNull();
    });

    it('keeps the row and toasts when the request fails', async () => {
      const r = renderApp(
        () => <Bots />,
        withRunners([connected], () => ({
          status: 500,
          body: { error: { code: 'internal', message: 'boom' } },
        })),
      );
      await r.flush();
      await r.click('[data-action="revoke-runner"]');
      window.__tg!.answerPopup('confirm');
      await r.flush();
      expect(r.root.querySelector('[data-runner="1"]')).not.toBeNull();
      expect(document.querySelector('.toast')?.textContent).toContain(t('app.common.error'));
    });
  });
});
