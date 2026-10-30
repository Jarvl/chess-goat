import { type GameDto } from '@group-chess/shared';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '../src/state/session';
import { createTg } from '../src/tg/webapp';

import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse } from './support/fakeFetch';
import { afterPlies, gameDto } from './support/gameFixtures';
import {
  cleanupGameScreen,
  dropAll,
  GAME,
  gameRoutes,
  mountGame,
  movePostsOf,
  played,
  putsOf,
  resetGameScreen,
  staleState,
  useConfirmations,
} from './support/gameScreen';
import { type Rendered } from './support/render';
import { type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

beforeEach(() => {
  adapter = resetGameScreen();
});
afterEach(cleanupGameScreen);

describe('Game with move confirmations', () => {
  beforeEach(() => {
    useConfirmations('people');
  });

  it('holds a move against a person for Confirm move, then sends it once', async () => {
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(r.root.querySelector('[data-action="abort"]')?.hasAttribute('disabled')).toBe(true);
    // Two taps before the screen re-renders still send one move.
    window.__tg!.clickMain();
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(1);
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('keeps the bar up with a spinner while a confirmed move sends', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mountGame(gameDto(), {
      route: gameRoutes(gameDto(), {
        move: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Sending…',
      visible: true,
      progress: true,
    });
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('puts the piece back on Cancel and sends nothing', async () => {
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(adapter.positions.at(-1)?.fen).toBe(gameDto().fen);
    expect(movePostsOf(r)).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('holds the waiting move on the board and in the strip through a snapshot', async () => {
    const r = mountGame(afterPlies(2));
    adapter.drop('b1', 'c3');
    await r.flush();
    const before = adapter.positions.length;
    // A draw offer bumps the version but is no new ply.
    FakeEventSource.instances[0]!.send(
      'state',
      afterPlies(2, { version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      '3',
    );
    await r.flush();
    expect(adapter.positions).toHaveLength(before);
    expect(r.text()).toContain('Bob offers a draw');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('Nc3');
  });

  it('holds a promotion for Confirm move once the piece is picked', async () => {
    const initial = gameDto({ fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1', plyCount: 6, version: 6 });
    const r = mountGame(initial);
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(movePostsOf(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'e7e8q', expectedPly: 6 });
  });

  it('shows the promoted piece, not chessground’s own pawn, while the promotion waits for Confirm', async () => {
    const initial = gameDto({ fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1', plyCount: 6, version: 6 });
    const r = mountGame(initial);
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(movePostsOf(r)).toHaveLength(0);
    const shown = adapter.positions.at(-1);
    expect(shown?.fen).toMatch(/^4Q3\//);
    expect(shown).toMatchObject({ lastMove: ['e7', 'e8'], turnColour: 'black' });
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.positions.at(-1)?.fen).toBe(initial.fen);
  });

  it('shows check on the board while a checking move waits for Confirm', async () => {
    const r = mountGame(
      gameDto({ fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', plyCount: 6, version: 6 }),
    );
    adapter.drop('a1', 'a8');
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(0);
    expect(adapter.positions.at(-1)).toMatchObject({ check: true, lastMove: ['a1', 'a8'] });
  });

  it('sends on drop against the bot under the default', async () => {
    const r = mountGame(gameDto({ engineLevel: 'casual' }));
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(1);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('holds a move against the bot when the setting is Always', async () => {
    useConfirmations('always');
    const r = mountGame(gameDto({ engineLevel: 'casual' }));
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('reads the setting at each drop, so a change mid-game applies to the next move', async () => {
    // The preference changes to 'never' after mount, before this drop.
    const r = mountGame(gameDto());
    prefs.value = { ...prefs.value, moveConfirmations: 'never' };
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(1);
  });

  it('puts Cancel in the action row below 7.10', async () => {
    const r = mountGame(gameDto(), { route: gameRoutes(gameDto()), version: '7.0' });
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector('[data-action="confirm-move"]')).toBeNull();
    await r.click('.toolbar [data-action="cancel-move"]');
    expect(movePostsOf(r)).toHaveLength(0);
    expect(r.root.querySelector('[data-action="cancel-move"]')).toBeNull();
  });

  it('puts both Confirm move and Cancel first in the action row without Telegram buttons', async () => {
    const initial = gameDto();
    const r = mountGame(initial, { tg: createTg(null) });
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const toolbar = r.root.querySelector('.toolbar')!;
    expect(toolbar.children[0]?.getAttribute('data-action')).toBe('confirm-move');
    expect(toolbar.children[1]?.getAttribute('data-action')).toBe('cancel-move');
    await r.click('[data-action="confirm-move"]');
    expect(
      r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`),
    ).toHaveLength(1);
  });

  it('hides the tab bar while a move waits and brings it back once the move is sent', async () => {
    const r = mountGame(gameDto());
    expect(r.app.router.suppressTabs.value).toBe(false);
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('brings the tab bar back on Cancel', async () => {
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickSecondary();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('keeps the tab bar hidden through a network retry of a confirmed move', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mountGame(gameDto(), {
      route: gameRoutes(gameDto(), {
        move: () => {
          failures += 1;
          if (failures === 1) throw new TypeError('Failed to fetch');
          return { status: 200, body: afterPlies(1) };
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100);
    window.__tg!.clickMain();
    await vi.advanceTimersByTimeAsync(100);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    expect(r.app.router.suppressTabs.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('drops a waiting move when the screen goes away, without asking and without sending', async () => {
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    // Telegram's own prompt guards closing while the move waits (this replaced the no-prompt rule).
    expect(window.__tg!.closingConfirmation).toBe(true);
    expect(r.app.router.leaveGuard).not.toBeNull();
    render(null, r.root);
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    window.__tg!.clickMain(); // the handler is gone with the screen
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(window.__tg!.popups).toHaveLength(0);
  });

  it('lets a confirmed move land when the app is minimised while it sends', async () => {
    // Minimising after Confirm must not cancel a send already in flight.
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mountGame(gameDto(), {
      route: gameRoutes(gameDto(), {
        move: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(adapter.restored).toBe(restored);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
  });

  it('keeps a waiting move through a draw offer, and drops it when the game ends under it', async () => {
    // Only a new ply or status cancels.
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    const before = adapter.positions.length;
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 1, drawOffer: { by: 'black', atPly: 0 } }),
      '1',
    );
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 2, status: 'finished', result: '*', endReason: 'abort' }),
      '2',
    );
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('restores the board and reloads the state when a confirmed move is answered 409', async () => {
    const r = mountGame(gameDto(), { route: gameRoutes(gameDto(), { move: () => staleState() }) });
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.clickMain();
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(adapter.restored).toBe(restored + 1);
    expect(r.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/api/games/${GAME}/moves`],
      ['GET', `/api/games/${GAME}`],
    ]);
  });

  it('cancels a waiting move when a new ply arrives from another device', async () => {
    const r = mountGame(gameDto());
    adapter.drop('e2', 'e4');
    await r.flush();
    const before = adapter.positions.length;
    // Same player moved from another device: plyCount changes, status stays active.
    FakeEventSource.instances[0]!.send('state', afterPlies(1, { viewerRole: 'white' }), '1');
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(movePostsOf(r)).toHaveLength(0);
    expect(adapter.positions.length).toBeGreaterThan(before);
  });
});

describe('Game leaving with an unconfirmed draft', () => {
  const LEAVE_TITLE = 'Leave this game?';
  const mountInGame = (initial: GameDto) => {
    const r = mountGame(initial);
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    return r;
  };
  const leaveByBack = async (r: Rendered, answer: 'confirm' | 'cancel') => {
    window.__tg!.clickBack();
    await r.flush();
    const popup = window.__tg!.popups.at(-1);
    window.__tg!.answerPopup(answer);
    await r.flush();
    return popup;
  };

  beforeEach(() => {
    useConfirmations('people');
  });

  it('asks about a waiting move alone, and Stay keeps the game and the draft', async () => {
    const r = mountInGame(played([]));
    await dropAll(r, [['e2', 'e4']]);
    const popup = await leaveByBack(r, 'cancel');
    expect(popup).toEqual({
      title: LEAVE_TITLE,
      message: "Your move hasn't been sent and will be lost.",
      buttons: [
        { id: 'cancel', type: 'default', text: 'Stay' },
        { id: 'confirm', type: 'destructive', text: 'Leave' },
      ],
    });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: GAME });
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('leaves on Leave', async () => {
    const r = mountInGame(played([]));
    await dropAll(r, [['e2', 'e4']]);
    await leaveByBack(r, 'confirm');
    expect(r.app.router.current.value).toEqual({ name: 'games' });
  });

  it('asks about the move and its premoves together', async () => {
    const r = mountInGame(played([]));
    await dropAll(r, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    const popup = await leaveByBack(r, 'cancel');
    expect(popup?.message).toBe("Your move and premoves haven't been sent and will be lost.");
  });

  it('asks about premove changes alone', async () => {
    const r = mountInGame(played(['e2e4']));
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    const popup = await leaveByBack(r, 'cancel');
    expect(popup).toMatchObject({
      title: LEAVE_TITLE,
      message: "Your premoves haven't been confirmed and will be lost.",
    });
  });

  it('guards a tab change, which is also what Telegram’s Settings item does', async () => {
    const r = mountInGame(played(['e2e4']));
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    r.app.router.select('settings');
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(1);
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.app.router.tab.value).toBe('games');
    r.app.router.select('settings');
    await r.flush();
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.app.router.tab.value).toBe('settings');
  });

  it('asks the client before closing while a draft is open, and not otherwise', async () => {
    const r = mountInGame(played([]));
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
    await dropAll(r, [['e2', 'e4']]);
    expect(r.app.router.leaveGuard).not.toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(true);
    window.__tg!.clickSecondary();
    await r.flush();
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
    // With nothing to lose, Back leaves without a question.
    window.__tg!.clickBack();
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
  });

  it('does not ask, or hold closing, once Confirm move is tapped and the move is sending', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const initial = played([]);
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        move: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await r.flush();
    await dropAll(r, [['e2', 'e4']]);
    expect(r.app.router.leaveGuard).not.toBeNull();
    window.__tg!.clickMain();
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Sending…', progress: true });
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
    r.app.router.select('settings');
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(r.app.router.tab.value).toBe('settings');
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
  });

  it('does not ask on Back while Confirm premoves is saving', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const initial = played(['e2e4']);
    const r = mountGame(initial, {
      route: (call) => {
        if (call.method === 'PUT' && call.path === `/api/games/${GAME}/premoves`)
          return new Promise<FakeResponse>((resolve) => (answer = resolve));
        return { status: 200, body: initial };
      },
    });
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(r.app.router.leaveGuard).not.toBeNull();
    window.__tg!.clickMain();
    await r.flush();
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
    window.__tg!.clickBack();
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
    answer({ status: 200, body: initial });
    await r.flush();
  });

  it('never asks with move confirmations off, even with a save still on its way', async () => {
    useConfirmations('never');
    let answer: (response: FakeResponse) => void = () => undefined;
    const initial = played(['e2e4']);
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        premovePut: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(putsOf(r)).toHaveLength(1);
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
    window.__tg!.clickBack();
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
    answer({ status: 200, body: initial });
    await r.flush();
  });
});
