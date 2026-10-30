import type { GameSummary, MeGamesDto } from '@group-chess/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { resetStrip, stripGames, type StripGame } from '../src/state/switcher';
import { setYourMoveCount, yourMoveCount } from '../src/state/yourMove';
import { STRIP_REFRESH_MS } from '../src/ui/game/useStrip';
import { gameDto } from './support/gameFixtures';
import {
  cleanupGameScreen,
  GAME,
  gameRoutes,
  mountGame,
  played,
  resetGameScreen,
  useConfirmations,
} from './support/gameScreen';
import type { FakeResponse } from './support/fakeFetch';
import type { Rendered } from './support/render';
import { type StubAdapter } from './support/stubAdapter';
import { gameSummary, playerRef } from './support/summaryFixtures';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

beforeEach(() => {
  adapter = resetGameScreen();
  resetStrip();
});
afterEach(cleanupGameScreen);

/** One of Alice's (the viewer's, white) games against `opponent`, whose user id is `userId`. */
const strip = (
  id: string,
  [userId, opponent]: [string, string],
  overrides: Partial<GameSummary> = {},
): StripGame => ({
  ...gameSummary({ id, black: playerRef(userId, opponent), ...overrides }),
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
});
const CURRENT = strip(GAME, ['2', 'Bob']);
const CAROL = strip('OtherAaaaa', ['3', 'Carol']);
const DAVE = strip('OtherBbbbb', ['4', 'Dave'], { yourTurn: false, sideToMove: 'black' });

/** A game screen on `initial` whose strip list answers `items`. */
const mountWith = (
  items: StripGame[],
  initial = gameDto(),
  opts: { hop?: boolean } = {},
): Rendered & { allCalls: Rendered['calls'] } =>
  mountGame(initial, {
    ...opts,
    route: gameRoutes(initial, {
      meGames: () => ({ status: 200, body: { items } satisfies MeGamesDto }),
      move: () => ({ status: 200, body: played(['e2e4']) }),
    }),
  });
const thumbs = (r: Rendered) =>
  [...r.root.querySelectorAll('.switcher [data-switch]')].map((el) =>
    el.getAttribute('data-switch'),
  );
const thumb = (r: Rendered, id: string) =>
  r.root.querySelector<HTMLElement>(`.switcher [data-switch="${id}"]`)!;

describe('the game switcher strip', () => {
  it('shows your other games, the current one ringed', async () => {
    const r = mountWith([CURRENT, CAROL, DAVE]);
    await r.flush();
    expect(thumbs(r)).toEqual([GAME, 'OtherAaaaa', 'OtherBbbbb']);
    expect(thumb(r, GAME).classList.contains('current')).toBe(true);
    expect(thumb(r, GAME).getAttribute('aria-current')).toBe('true');
    expect(thumb(r, 'OtherBbbbb').classList.contains('dim')).toBe(true);
    expect(thumb(r, 'OtherBbbbb').querySelector('.dot')).toBeNull();
    expect(thumb(r, 'OtherAaaaa').classList.contains('dim')).toBe(false);
    expect(thumb(r, 'OtherAaaaa').querySelector('.dot')).not.toBeNull();
    const names = [...r.root.querySelectorAll('.switcher .name')].map((el) => el.textContent);
    expect(names).toEqual(['Bob', 'Carol', 'Dave']);
    expect(r.root.querySelector('.game')!.classList.contains('with-switcher')).toBe(true);
  });

  it('sits at the bottom, under the game buttons, within reach of a thumb', async () => {
    const r = mountWith([CURRENT, CAROL, DAVE]);
    await r.flush();
    const game = r.root.querySelector('.game')!;
    expect(game.lastElementChild!.classList.contains('switcher')).toBe(true);
    expect(game.lastElementChild!.previousElementSibling!.classList.contains('icon-bar')).toBe(
      true,
    );
  });

  it('is hidden when there is no other game', async () => {
    const r = mountWith([CURRENT]);
    await r.flush();
    expect(r.root.querySelector('.switcher')).toBeNull();
    expect(r.root.querySelector('.game')!.classList.contains('with-switcher')).toBe(false);
  });

  it('still shows on a game that just ended', async () => {
    const r = mountWith(
      [CAROL, DAVE],
      gameDto({ status: 'finished', result: '1-0', endReason: 'resignation' }),
    );
    await r.flush();
    expect(thumbs(r)).toEqual(['OtherAaaaa', 'OtherBbbbb']);
    expect(r.root.querySelector('.switcher .current')).toBeNull();
  });

  it('is hidden when watching', async () => {
    const r = mountWith([CURRENT, CAROL, DAVE], gameDto({ viewerRole: 'spectator' }));
    await r.flush();
    expect(r.root.querySelector('.switcher')).toBeNull();
  });

  it('opens a game in place, so Back still leads to the list', async () => {
    const r = mountWith([CURRENT, CAROL, DAVE]);
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await r.flush();
    await r.click('[data-switch="OtherAaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'OtherAaaaa', hop: true });
    expect(r.app.router.back()).toBe(true);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
  });

  it('does nothing on the current game', async () => {
    const r = mountWith([CURRENT, CAROL, DAVE]);
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await r.flush();
    await r.click(`[data-switch="${GAME}"]`);
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: GAME });
  });

  it('asks once before leaving an unsent move', async () => {
    useConfirmations('people');
    const r = mountWith([CURRENT, CAROL, DAVE]);
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    await r.click('[data-switch="OtherAaaaa"]');
    await r.click('[data-switch="OtherAaaaa"]');
    expect(window.__tg!.popups).toHaveLength(1);
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: GAME });
  });

  it('keeps the order it arrived with when you hop', async () => {
    stripGames.value = [DAVE, CURRENT, CAROL];
    const r = mountWith([CURRENT, CAROL, DAVE], gameDto(), { hop: true });
    await r.flush();
    expect(thumbs(r)).toEqual(['OtherBbbbb', GAME, 'OtherAaaaa']);
  });

  it('starts a fresh order when you arrive from elsewhere', async () => {
    stripGames.value = [DAVE, CURRENT, CAROL];
    const r = mountWith([CURRENT, CAROL, DAVE]);
    await r.flush();
    expect(thumbs(r)).toEqual([GAME, 'OtherAaaaa', 'OtherBbbbb']);
  });

  it('draws the current game from the board, not the list', async () => {
    useConfirmations('never');
    const r = mountWith([CURRENT, CAROL, DAVE]);
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(thumb(r, GAME).querySelector('[data-square="e4"]')!.classList.contains('lm')).toBe(true);
    expect(thumb(r, GAME).classList.contains('dim')).toBe(false);
  });
});

describe('refreshing the strip', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  /** A game screen whose strip list answers each of `answers` in turn, the last one from then on. */
  const mountAnswering = (answers: (FakeResponse | Promise<FakeResponse>)[]) => {
    let next = 0;
    return mountGame(gameDto(), {
      route: gameRoutes(gameDto(), {
        meGames: () => answers[Math.min(next++, answers.length - 1)]!,
      }),
    });
  };
  const list = (...items: StripGame[]): FakeResponse => ({ status: 200, body: { items } });
  const gets = (r: { allCalls: Rendered['calls'] }) =>
    r.allCalls.filter((call) => call.path === '/api/me/games').length;
  const settle = () => vi.advanceTimersByTimeAsync(100);

  it('refreshes every 30 seconds', async () => {
    const daveToMove = { ...DAVE, yourTurn: true };
    const r = mountAnswering([list(CURRENT, CAROL, DAVE), list(CURRENT, CAROL, daveToMove)]);
    await settle();
    expect(gets(r)).toBe(1);
    expect(thumb(r, 'OtherBbbbb').classList.contains('dim')).toBe(true);
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(gets(r)).toBe(2);
    expect(thumb(r, 'OtherBbbbb').classList.contains('dim')).toBe(false);
    expect(thumb(r, 'OtherBbbbb').querySelector('.dot')).not.toBeNull();
  });

  it('refreshes when the app comes back, and not while it is hidden', async () => {
    const r = mountAnswering([list(CURRENT, CAROL, DAVE)]);
    await settle();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2 * STRIP_REFRESH_MS);
    expect(gets(r)).toBe(1);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(gets(r)).toBe(2);
  });

  it('keeps the last strip when a refresh fails', async () => {
    const r = mountAnswering([
      list(CURRENT, CAROL, DAVE),
      { status: 500, body: { error: { code: 'internal', message: 'boom' } } },
    ]);
    await settle();
    await vi.advanceTimersByTimeAsync(STRIP_REFRESH_MS);
    expect(gets(r)).toBe(2);
    expect(thumbs(r)).toEqual([GAME, 'OtherAaaaa', 'OtherBbbbb']);
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('reconciles the Games badge', async () => {
    setYourMoveCount(0);
    mountAnswering([list(CURRENT, CAROL, DAVE)]);
    await settle();
    expect(yourMoveCount.value).toBe(2);
  });

  it('stops refreshing once the game screen is gone', async () => {
    const r = mountAnswering([list(CURRENT, CAROL, DAVE)]);
    await settle();
    act(() => render(null, r.root)); // effect cleanups run now, as on a real unmount
    await vi.advanceTimersByTimeAsync(2 * STRIP_REFRESH_MS);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(gets(r)).toBe(1);
  });

  it('ignores a list that arrives after the game screen is gone', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mountAnswering([new Promise<FakeResponse>((resolve) => (answer = resolve))]);
    await settle();
    act(() => render(null, r.root)); // effect cleanups run now, as on a real unmount
    answer(list(CURRENT, CAROL, DAVE));
    await settle();
    expect(stripGames.value).toBeNull();
  });
});
