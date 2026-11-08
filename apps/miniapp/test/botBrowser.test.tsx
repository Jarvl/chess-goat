import type { BotCardDto, BotListDto, LobbyDto } from '@chess-goat/shared';
import { t } from '@chess-goat/shared';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverOffsetMs } from '../src/state/session';
import { BotBrowser } from '../src/ui/screens/BotBrowser';
import type { FakeRoute } from './support/fakeFetch';
import { renderApp } from './support/render';
import { playerRef } from './support/summaryFixtures';

const lobby = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  isAdmin: false,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [],
  finished: { items: [], nextCursor: null },
  challenges: [],
  players: [],
} as unknown as LobbyDto;

const card = (id: number, overrides: Partial<BotCardDto> = {}): BotCardDto => ({
  ...playerRef(String(id), `🤖 Bot${id} (@zed)`),
  rating: 1500 + id,
  provisional: false,
  kind: 'bot',
  botActivity: { lastActiveAt: null },
  tagline: `Tagline ${id}`,
  owner: '@zed',
  isMine: false,
  gamesPlayed: 4,
  record: { wins: 2, draws: 1, losses: 1 },
  ...overrides,
});

const page = (ids: number[], nextCursor: string | null = null): BotListDto => ({
  group: { title: 'Chess Club' },
  bots: ids.map((id) => card(id)),
  nextCursor,
});

/** The group's lobby, and a bot list answered by `bots` (given the query string). */
function server(bots: (query: URLSearchParams) => BotListDto): FakeRoute {
  return ({ path }) => {
    if (path.startsWith('/api/groups/GrOuPiDxYz/bots')) {
      return { status: 200, body: bots(new URL(path, 'https://x').searchParams) };
    }
    return { status: 200, body: lobby };
  };
}
const botCalls = (r: ReturnType<typeof renderApp>) =>
  r.calls.filter((c) => c.path.includes('/bots')).map((c) => new URL(c.path, 'https://x'));

afterEach(() => {
  vi.useRealTimers();
  serverOffsetMs.value = 0;
});

describe('BotBrowser', () => {
  it('titles the group and lists the bots with tagline, rating, record and activity', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server(() => page([1, 2])),
    );
    await r.flush();
    expect(r.root.querySelector('h1')?.textContent).toBe(
      t('app.bots.browse_title', { group: 'Chess Club' }),
    );
    const rows = r.root.querySelectorAll('[data-bot]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('🤖 Bot1 (@zed)');
    expect(rows[0]?.textContent).toContain('Tagline 1');
    expect(rows[0]?.textContent).toContain('1501');
    expect(rows[0]?.textContent).toContain(
      t('app.player.record', { wins: 2, draws: 1, losses: 1 }),
    );
    expect(rows[0]?.textContent).toContain(t('app.player.bot_never_active'));
    expect(botCalls(r)[0]?.searchParams.get('sort')).toBe('rating');
    // The title comes with the list: the lobby is not fetched for it.
    expect(r.calls.map((c) => c.path).filter((path) => !path.includes('/bots'))).toEqual([]);
  });

  it("reads activity against the server's clock", async () => {
    serverOffsetMs.value = -3 * 3_600_000;
    const lastActiveAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server(() => ({ ...page([]), bots: [card(1, { botActivity: { lastActiveAt } })] })),
    );
    await r.flush();
    expect(r.root.querySelector('.bot-activity')?.textContent).toBe(t('app.player.bot_active_now'));
  });

  it('says no bot matches a search that finds none', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server((q) => (q.get('q') ? page([]) : page([1]))),
    );
    await r.flush();
    vi.useFakeTimers();
    const input = r.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'zz';
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await r.flush();
    expect(r.root.textContent).toContain('No bots match "zz".');
    expect(r.root.textContent).not.toContain(t('app.bots.none'));
  });

  it('shows the empty state', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server(() => page([])),
    );
    await r.flush();
    expect(r.root.textContent).toContain(t('app.bots.none'));
    expect(r.root.querySelector('[data-action="more"]')).toBeNull();
  });

  it('loads more with the cursor and then stops offering it', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server((q) => (q.get('cursor') === 'c1' ? page([3]) : page([1, 2], 'c1'))),
    );
    await r.flush();
    await r.click('[data-action="more"]');
    expect(r.root.querySelectorAll('[data-bot]')).toHaveLength(3);
    expect(botCalls(r).at(-1)?.searchParams.get('cursor')).toBe('c1');
    expect(r.root.querySelector('[data-action="more"]')).toBeNull();
  });

  it('searches 300 ms after typing stops', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server((q) => (q.get('q') === 'rook' ? page([9]) : page([1, 2]))),
    );
    await r.flush();
    vi.useFakeTimers();
    const input = r.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input.placeholder).toBe(t('app.bots.search'));
    input.value = 'rook';
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(botCalls(r)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();
    await r.flush();
    expect(botCalls(r)).toHaveLength(2);
    expect(botCalls(r)[1]?.searchParams.get('q')).toBe('rook');
    expect(r.root.querySelectorAll('[data-bot]')).toHaveLength(1);
  });

  it('re-queries from the start when the sort changes', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server(() => page([1], 'c1')),
    );
    await r.flush();
    await r.click('[data-sort="active"]');
    const last = botCalls(r).at(-1)!;
    expect(last.searchParams.get('sort')).toBe('active');
    expect(last.searchParams.get('cursor')).toBeNull();
    expect(r.root.querySelector('[data-sort="active"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('swaps itself back for New game when it stands in for one', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'botBrowser', groupId: 'GrOuPiDxYz', from: 'newGame' }, [
          { name: 'lobby', groupId: 'GrOuPiDxYz' },
        ]);
        return <BotBrowser groupId="GrOuPiDxYz" from="newGame" />;
      },
      server(() => page([1, 2])),
    );
    await r.flush();
    await r.click('[data-bot="2"]');
    expect(r.app.router.stack.value).toEqual([
      { name: 'lobby', groupId: 'GrOuPiDxYz' },
      { name: 'newGame', groupId: 'GrOuPiDxYz', opponentId: '2' },
    ]);
  });

  it('opens New Game against the tapped bot', async () => {
    const r = renderApp(
      () => <BotBrowser groupId="GrOuPiDxYz" />,
      server(() => page([1, 2])),
    );
    await r.flush();
    await r.click('[data-bot="2"]');
    expect(r.app.router.current.value).toEqual({
      name: 'newGame',
      groupId: 'GrOuPiDxYz',
      opponentId: '2',
    });
  });
});
