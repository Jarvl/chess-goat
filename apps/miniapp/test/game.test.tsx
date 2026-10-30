import type { MoveConfirmations } from '@group-chess/shared';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs, session } from '../src/state/session';
import { createTg } from '../src/tg/webapp';
import { Game } from '../src/ui/screens/Game';
import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse, FakeRoute } from './support/fakeFetch';
import { afterPlies, gameDto, pair, treeText } from './support/gameFixtures';
import { renderApp } from './support/render';
import { stubAdapter, type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

const GAME = 'AbCdEfGhIj';
const okRoute =
  (initial: ReturnType<typeof gameDto>, onMove?: FakeRoute): FakeRoute =>
  (call) => {
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves` && onMove)
      return onMove(call);
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves`)
      return { status: 200, body: afterPlies(1) };
    if (call.method === 'GET' && call.path === `/api/games/${GAME}`)
      return { status: 200, body: initial };
    if (call.method === 'POST' && /\/(draw\/\w+|resign|abort)$/.test(call.path))
      return { status: 200, body: initial };
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/pgn-link`)
      return { status: 200, body: { url: `/api/games/${GAME}/pgn?token=scoped-link` } };
    return { status: 200, body: { ok: true } };
  };

const wantPrefs: { moveConfirmations: MoveConfirmations } = {
  // The flows below predate move confirmations; the describe block for them sets its own.
  moveConfirmations: 'never',
};

function mount(
  initial: ReturnType<typeof gameDto>,
  route: FakeRoute = okRoute(initial),
  version = '8.0',
) {
  const r = renderApp(
    (app) => {
      app.prefetched.game = initial;
      return <Game gameId={GAME} />;
    },
    route,
    { version },
  );
  // renderApp resets the preferences; the screen reads them when a move is dropped.
  prefs.value = { ...prefs.value, ...wantPrefs };
  return r;
}

const slider = (r: ReturnType<typeof mount>) =>
  r.root.querySelector<HTMLInputElement>('.replay-controls input[type="range"]')!;

beforeEach(() => {
  adapter = stubAdapter();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  wantPrefs.moveConfirmations = 'never';
});
afterEach(async () => {
  // Preact flushes effects on animation frames; run the faked ones before real timers return,
  // otherwise its effect queue stays scheduled forever and later tests never run their effects.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Game', () => {
  it('renders the players, clocks and moves from the launch data and opens the stream', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'black' }));
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/games/${GAME}/events?token=jwt`);
    expect(r.text()).toContain('Alice');
    expect(r.text()).toContain('Bob');
    expect(r.text()).toContain('1d 0:00');
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
    expect(adapter.positions.at(-1)).toMatchObject({
      orientation: 'black',
      lastMove: ['e7', 'e5'],
    });
    // Black waits, so its pieces lift for premoves.
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'black' });
  });

  it('sends a move as soon as it is dropped and applies the response', async () => {
    const r = mount(gameDto());
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    adapter.drop('e2', 'e4');
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/api/games/${GAME}/moves`);
    expect(post?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect((post?.body as { clientMoveId: string }).clientMoveId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
    expect(window.__tg!.haptics).toContain('impact:light');
    // Showing the Telegram main button resizes the viewport, and with it the board.
    expect(window.__tg!.calls).not.toContain('MainButton.show');
    expect(r.root.querySelector('.board-veil')).toBeNull();
  });

  it('greys the board under a spinner only once a send is slow', async () => {
    vi.useFakeTimers();
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(900);
    expect(r.root.querySelector('.board-veil')).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    const veil = r.root.querySelector('.board-wrap .board-veil');
    expect(veil?.getAttribute('aria-label')).toBe('Sending…');
    expect(veil?.querySelector('.spinner')).not.toBeNull();
    expect(window.__tg!.calls).not.toContain('MainButton.show');
    answer({ status: 200, body: afterPlies(1) });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.root.querySelector('.board-veil')).toBeNull();
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
  });

  it('buzzes a warning when a state arriving over the stream puts the viewer in check', async () => {
    // Black rook a2, white king e1: no check with Black to move …
    const quiet = gameDto({ fen: '4k3/8/8/8/8/8/r7/4K3 b - - 0 1', plyCount: 9, version: 9 });
    const r = mount(quiet);
    await r.flush();
    // … then the rook slides to e2 and White is in check.
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen: '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1', plyCount: 10, version: 10 }),
      '10',
    );
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:warning');
    expect(adapter.positions.at(-1)?.check).toBe(true);
  });

  it('snaps back silently on a stale rejection and reloads the state', async () => {
    const r = mount(
      gameDto(),
      okRoute(afterPlies(1, { viewerRole: 'white' }), () => ({
        status: 409,
        body: { error: { code: 'stale_state', message: 'the position has changed' } },
      })),
    );
    await r.flush();
    const before = adapter.positions.length;
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(r.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/api/games/${GAME}/moves`],
      ['GET', `/api/games/${GAME}`],
    ]);
    expect(r.text()).not.toContain('position has changed');
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('retries with the same client move id after a network failure', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => {
        failures += 1;
        if (failures === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: afterPlies(1) };
      }),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    const first = r.calls.find((c) => c.method === 'POST')?.body as { clientMoveId: string };
    await vi.advanceTimersByTimeAsync(1_000);
    const posts = r.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/moves'));
    expect(posts).toHaveLength(2);
    expect((posts[1]?.body as { clientMoveId: string }).clientMoveId).toBe(first.clientMoveId);
    expect(r.calls.some((c) => c.path === '/api/telemetry')).toBe(true);
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('stays on the game after a move, even when launched from a game link', async () => {
    vi.useFakeTimers();
    const r = mount(gameDto());
    session.value = { ...session.value!, launchedFrom: { kind: 'game', gameId: GAME } };
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.calls.some((c) => c.path === `/api/games/${GAME}/moves`)).toBe(true);
    expect(window.__tg!.closed).toBe(false);
  });

  it('shows the promotion chooser and sends the chosen piece', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    await r.click('[data-promote="n"]');
    expect(r.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      uci: 'e7e8n',
      expectedPly: 6,
    });
  });

  it('offers, accepts and declines draws and shows the opponent’s offer', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    await r.click('[data-action="offer-draw"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Offer a draw?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/offer`);
    FakeEventSource.instances[0]!.send(
      'state',
      afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      '3',
    );
    await r.flush();
    expect(r.text()).toContain('Bob offers a draw');
    await r.click('[data-action="accept-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/accept`);
    await r.click('[data-action="decline-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/decline`);
  });

  it('ends a finished game with share, analyze, PGN and rematch in the bar, with the PGN link fallback', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      lichessUrl: 'https://lichess.org/abcd1234',
      black: { ...gameDto().black, ratingAfter: 1662, provisionalAfter: true },
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    const labels = [...r.root.querySelectorAll('.icon-bar button')].map((b) => [
      b.getAttribute('data-action'),
      b.textContent,
    ]);
    expect(labels).toEqual([
      ['share', 'Share to group'],
      ['analyse', 'Analyze'],
      ['pgn', 'PGN'],
      ['rematch', 'Rematch'],
    ]);
    // Telegram's own Close does what Done did.
    expect(r.root.querySelector('[data-action="done"]')).toBeNull();
    expect(r.root.querySelector('.toolbar')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
    await r.click('[data-action="analyse"]');
    expect(window.__tg!.links).toContain('https://lichess.org/abcd1234');
    await r.click('[data-action="pgn"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/pgn-link`);
    expect(window.__tg!.links.at(-1)).toContain(`/api/games/${GAME}/pgn?token=scoped-link`);
    expect(window.__tg!.links.at(-1)).not.toContain('jwt');
    expect(window.__tg!.downloads).toEqual([]);
    await r.click('[data-action="rematch"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/rematch`);
    await r.click('[data-ply="2"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['e7', 'e5']);
    expect(r.root.querySelector('[data-action="latest"]')).toBeNull();
    await r.click('[data-ply="4"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['d8', 'h4']);
  });

  it('shows the result on the player bars in place of the clocks, with no result card', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      black: { ...gameDto().black, ratingAfter: 1662, provisionalAfter: true },
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    const white = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const black = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(r.root.querySelector('.result-card')).toBeNull();
    expect(r.root.querySelector('.clock')).toBeNull();
    expect(black.querySelector('.result-tag')?.textContent).toBe('Won');
    expect(black.querySelector('.result-tag')?.className).toContain('won');
    expect(black.querySelector('.sub')?.textContent).toBe('Checkmate');
    expect(black.querySelector('.sub')?.className).toContain('reason');
    expect(black.querySelector('.rating')?.textContent).toBe('1500? → 1662?');
    expect(white.querySelector('.result-tag')?.textContent).toBe('Lost');
    expect(white.querySelector('.sub')).toBeNull();
  });

  it('tags both bars Draw with the reason under each name', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'white',
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    for (const bar of r.root.querySelectorAll('.player-bar')) {
      expect(bar.querySelector('.result-tag')?.textContent).toBe('Draw');
      expect(bar.querySelector('.sub')?.textContent).toBe('Draw agreed');
    }
  });

  it('tags both bars Voided for a voided game, and offers no rematch', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'white',
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      voided: true,
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    const tags = [...r.root.querySelectorAll('.result-tag')].map((tag) => tag.textContent);
    expect(tags).toEqual(['Voided', 'Voided']);
    expect(r.root.querySelector('[data-action="rematch"]')).toBeNull();
  });

  it('gives spectators of a finished game share, analyze and PGN, with Analyze dimmed without a link', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'spectator',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    const actions = [...r.root.querySelectorAll('.icon-bar button')].map((b) =>
      b.getAttribute('data-action'),
    );
    expect(actions).toEqual(['share', 'analyse', 'pgn']);
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="analyse"]')?.disabled).toBe(true);
  });

  it('shows the replay slider in a game still being played, and holds moves while it looks back', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const slider = r.root.querySelector<HTMLInputElement>('.replay-controls input[type="range"]')!;
    expect(slider).not.toBeNull();
    expect(slider.max).toBe('2');
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'white' });
    await r.click('[data-action="prev"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['f2', 'f3']);
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'none' });
    await r.click('[data-action="next"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['e7', 'e5']);
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'white' });
  });

  it('shows the slider before the first move, with nothing to step through', async () => {
    const r = mount(gameDto({ viewerRole: 'white' }));
    await r.flush();
    const slider = r.root.querySelector<HTMLInputElement>('.replay-controls input[type="range"]')!;
    expect(slider.max).toBe('0');
    expect(slider.disabled).toBe(true);
  });

  it('starts a fresh bot game on rematch when the finished game was against the engine', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      engineLevel: 'club',
    });
    const nextGame = gameDto({ id: 'NextGameA1', engineLevel: 'club' });
    const route: FakeRoute = (call) => {
      if (call.method === 'POST' && call.path === `/api/groups/${finished.group.id}/engine-games`)
        return { status: 200, body: nextGame };
      return okRoute(finished)(call);
    };
    const r = mount(finished, route, '7.0');
    await r.flush();
    await r.click('[data-action="rematch"]');
    const post = r.calls.at(-1);
    expect(post?.path).toBe(`/api/groups/${finished.group.id}/engine-games`);
    expect(post?.body).toEqual({ level: 'club', colour: 'random' });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'NextGameA1' });
  });

  it('lets spectators flip and share the viewed position', async () => {
    const r = mount(afterPlies(3, { viewerRole: 'spectator' }));
    await r.flush();
    expect(adapter.viewOnly).toBe(true);
    await r.click('[data-action="flip"]');
    expect(adapter.positions.at(-1)?.orientation).toBe('black');
    await r.click('[data-ply="1"]');
    await r.click('[data-action="share"]');
    expect(r.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/games/${GAME}/share`,
      body: { ply: 1 },
    });
    expect(document.querySelector('.toast')?.textContent).toBe('Shared to Chess Club');
    // The same icon bar as a player's, with its two buttons in two wide slots.
    const labels = [...r.root.querySelectorAll('.icon-bar.two button')].map((b) => [
      b.getAttribute('data-action'),
      b.textContent,
    ]);
    expect(labels).toEqual([
      ['share', 'Share to group'],
      ['flip', 'Flip'],
    ]);
    expect(r.root.querySelector('.pill-btn[data-action="share"]')).toBeNull();
  });

  it('gives a player four fixed slots: share to group, flip, draw and resign', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const labels = [...r.root.querySelectorAll('.icon-bar button')].map((b) => [
      b.getAttribute('data-action'),
      b.textContent,
    ]);
    expect(labels).toEqual([
      ['share', 'Share to group'],
      ['flip', 'Flip'],
      ['offer-draw', '½Draw'],
      ['resign', 'Resign'],
    ]);
    await r.click('[data-action="flip"]');
    expect(adapter.positions.at(-1)?.orientation).toBe('black');
    await r.click('[data-action="resign"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Resign this game?');
  });

  it('dims Draw to Offered after your offer, leaving the slots in place', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white', drawOffer: { by: 'white', atPly: 2 } }));
    await r.flush();
    const draw = r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')!;
    expect(draw.textContent).toBe('½Offered');
    expect(draw.disabled).toBe(true);
    expect(r.root.querySelectorAll('.icon-bar button')).toHaveLength(4);
  });

  it('dims Draw against the bot', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white', engineLevel: 'club' }));
    await r.flush();
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')?.disabled).toBe(
      true,
    );
  });

  it('reads Abort in the last slot before the second move, with Draw dimmed', async () => {
    const r = mount(gameDto({ viewerRole: 'white' }));
    await r.flush();
    expect(r.root.querySelector('[data-action="resign"]')).toBeNull();
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')?.disabled).toBe(
      true,
    );
    await r.click('[data-action="abort"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Abort this game?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/abort`);
  });

  it('marks your bar and clock gold on your move, and leaves the waiting side plain', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const mine = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const theirs = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(mine.className).toContain('yours');
    expect(mine.querySelector('.sub')?.textContent).toBe('Your move');
    expect(mine.querySelector('.clock')?.className).toContain('yours');
    expect(theirs.className).not.toContain('yours');
    expect(theirs.querySelector('.sub')).toBeNull();
    expect(theirs.querySelector('.avatar')?.textContent).toBe('B');
  });

  it('names the group and terms once, above the top bar', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const meta = r.root.querySelector('.game > .game-meta');
    expect(meta?.textContent).toBe('Chess Club · 1 day per move · Rated');
    expect(meta?.nextElementSibling?.classList.contains('player-bar')).toBe(true);
  });

  it('shows the pieces each side took, and +N only for the side ahead', async () => {
    // Black has taken a knight and a pawn; white has taken the queen.
    const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKB1R w KQkq - 0 5';
    const r = mount(gameDto({ fen, plyCount: 8, version: 8 }));
    await r.flush();
    const white = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const black = r.root.querySelector('.player-bar[data-colour="black"]')!;
    const taken = (bar: Element) =>
      [...bar.querySelectorAll('.captured piece')].map((p) => p.className);
    expect(taken(white)).toEqual(['queen black']);
    expect(taken(black)).toEqual(['knight white', 'pawn white']);
    expect(white.querySelector('.lead')?.textContent).toBe('+5');
    expect(black.querySelector('.lead')).toBeNull();
    expect(white.querySelector('.sub')?.textContent).toBe('Your move');
  });

  it('counts material from the position being replayed', async () => {
    const r = mount(
      gameDto({
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 5',
        plyCount: 8,
        version: 8,
      }),
    );
    await r.flush();
    const white = () => r.root.querySelector('.player-bar[data-colour="white"]')!;
    expect(white().querySelector('.lead')?.textContent).toBe('+9');
    slider(r).value = '0';
    slider(r).dispatchEvent(new Event('input'));
    await r.flush();
    expect(white().querySelector('.captured')).toBeNull();
    expect(white().querySelector('.lead')).toBeNull();
  });

  it('shows the bot as the goat with its level', async () => {
    const bot = { ...gameDto().black, name: 'Stockfish', isBot: true };
    const r = mount(
      gameDto({ black: bot, engineLevel: 'club', timePerMove: null, deadlineAt: null }),
    );
    await r.flush();
    const bar = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(bar.querySelector('img.avatar.bot')).not.toBeNull();
    expect(bar.querySelector('.rating')?.textContent).toBe('Club');
  });
});

describe('Game with move confirmations', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });
  const posts = (r: ReturnType<typeof mount>) =>
    r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`);

  it('holds a move against a person for Confirm move, then sends it once', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(r.root.querySelector('[data-action="abort"]')?.hasAttribute('disabled')).toBe(true);
    // Two taps before the screen re-renders still send one move.
    window.__tg!.clickMain();
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('keeps the bar up with a spinner while a confirmed move sends', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
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
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(adapter.positions.at(-1)?.fen).toBe(gameDto().fen);
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('holds the waiting move on the board through a snapshot, and locks the move strip', async () => {
    const r = mount(afterPlies(2));
    await r.flush();
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
    expect(r.root.querySelector<HTMLButtonElement>('.move-list [data-ply="1"]')?.disabled).toBe(
      true,
    );
  });

  it('holds a promotion for Confirm move once the piece is picked', async () => {
    const initial = gameDto({ fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1', plyCount: 6, version: 6 });
    const r = mount(initial);
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e7e8q', expectedPly: 6 });
  });

  it('shows the promoted piece, not chessground’s own pawn, while the promotion waits for Confirm', async () => {
    const initial = gameDto({ fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1', plyCount: 6, version: 6 });
    const r = mount(initial);
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(posts(r)).toHaveLength(0);
    const shown = adapter.positions.at(-1);
    expect(shown?.fen).toMatch(/^4Q3\//);
    expect(shown).toMatchObject({ lastMove: ['e7', 'e8'], turnColour: 'black' });
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.positions.at(-1)?.fen).toBe(initial.fen);
  });

  it('shows check on the board while a checking move waits for Confirm', async () => {
    const r = mount(gameDto({ fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('a1', 'a8');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(adapter.positions.at(-1)).toMatchObject({ check: true, lastMove: ['a1', 'a8'] });
  });

  it('sends on drop against the bot under the default', async () => {
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('holds a move against the bot when the setting is Always', async () => {
    wantPrefs.moveConfirmations = 'always';
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('reads the setting at each drop, so a change mid-game applies to the next move', async () => {
    // The preference changes to 'never' after mount, before this drop.
    const r = mount(gameDto());
    await r.flush();
    prefs.value = { ...prefs.value, moveConfirmations: 'never' };
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
  });

  it('puts Cancel in the action row below 7.10', async () => {
    const r = mount(gameDto(), okRoute(gameDto()), '7.0');
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector('[data-action="confirm-move"]')).toBeNull();
    await r.click('.toolbar [data-action="cancel-move"]');
    expect(posts(r)).toHaveLength(0);
    expect(r.root.querySelector('[data-action="cancel-move"]')).toBeNull();
  });

  it('puts both Confirm move and Cancel first in the action row without Telegram buttons', async () => {
    const initial = gameDto();
    const r = renderApp(
      (app) => {
        app.prefetched.game = initial;
        return <Game gameId={GAME} />;
      },
      okRoute(initial),
      { tg: createTg(null) },
    );
    prefs.value = { ...prefs.value, ...wantPrefs };
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
    const r = mount(gameDto());
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('brings the tab bar back on Cancel', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickSecondary();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('keeps the tab bar hidden through a network retry of a confirmed move', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => {
        failures += 1;
        if (failures === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: afterPlies(1) };
      }),
    );
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
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
    render(null, r.root);
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    window.__tg!.clickMain(); // the handler is gone with the screen
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(window.__tg!.calls).not.toContain('enableClosingConfirmation');
  });

  it('drops a waiting move when Telegram minimises the app', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('lets a confirmed move land when the app is minimised while it sends', async () => {
    // Minimising after Confirm must not cancel a send already in flight.
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
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
    const r = mount(gameDto());
    await r.flush();
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

  it('stays on the game after a confirmed move, even when launched from a game card', async () => {
    vi.useFakeTimers();
    const r = mount(gameDto());
    session.value = { ...session.value!, launchedFrom: { kind: 'game', gameId: GAME } };
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100);
    window.__tg!.clickMain();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts(r)).toHaveLength(1);
    expect(window.__tg!.closed).toBe(false);
  });

  it('restores the board and reloads the state when a confirmed move is answered 409', async () => {
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => ({
        status: 409,
        body: { error: { code: 'stale_state', message: 'the position has changed' } },
      })),
    );
    await r.flush();
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
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const before = adapter.positions.length;
    // Same player moved from another device: plyCount changes, status stays active.
    FakeEventSource.instances[0]!.send('state', afterPlies(1, { viewerRole: 'white' }), '1');
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(posts(r)).toHaveLength(0);
    expect(adapter.positions.length).toBeGreaterThan(before);
  });
});

describe('Game premoves and Share position', () => {
  it('shares the real position, never the imagined one, at any premove step', async () => {
    // After 1. f3 it is Black's move; White has queued Nh3 and Ng5.
    const r = mount(afterPlies(1, { viewerRole: 'white', premoves: ['g1h3', 'h3g5'] }));
    await r.flush();
    await r.click('[data-action="share"]');
    await r.click('[data-action="prev"]');
    await r.click('[data-action="share"]');
    const shares = r.calls.filter((c) => c.path === `/api/games/${GAME}/share`);
    expect(shares.map((c) => c.body)).toEqual([{ ply: 1 }, { ply: 1 }]);
  });
});

describe('Game premoves', () => {
  // After 1. f3 it is Black's move; the viewer is White.
  const waiting = (premoves: string[] = []) => afterPlies(1, { viewerRole: 'white', premoves });
  const echoPut =
    (initial: ReturnType<typeof gameDto>, onPut?: FakeRoute): FakeRoute =>
    (call) => {
      if (call.method === 'PUT' && call.path === `/api/games/${GAME}/premoves`) {
        if (onPut) return onPut(call);
        return {
          status: 200,
          body: { ...initial, premoves: (call.body as { premoves: string[] }).premoves },
        };
      }
      return okRoute(initial)(call);
    };

  it('queues a premove on the opponent’s turn without asking, even with confirmations on Always', async () => {
    wantPrefs.moveConfirmations = 'always';
    const r = mount(waiting(), echoPut(waiting()));
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    expect(adapter.movables.at(-1)?.dests.get('g1')).toEqual(
      expect.arrayContaining(['e2', 'f3', 'h3']),
    );
    adapter.drop('g1', 'h3');
    await r.flush();
    expect(r.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      base: [],
      premoves: ['g1h3'],
      expectedPly: 1,
    });
    expect(window.__tg!.calls).not.toContain('MainButton.show');
    expect(r.root.querySelector('.move-list [data-premove="1"]')?.textContent).toBe('Nh3');
    expect(slider(r)).toMatchObject({ value: '2', max: '2' });
    expect(slider(r).classList.contains('premove')).toBe(true);
    expect(adapter.highlights.at(-1)).toEqual(['g1', 'h3']);
    expect(r.root.querySelector('.board-wrap')?.classList.contains('premove')).toBe(true);
  });

  it('asks for the promotion piece and queues it with the premove', async () => {
    const initial = gameDto({ fen: '4k3/4P3/8/8/8/8/8/K7 b - - 0 1', plyCount: 7, version: 7 });
    const r = mount(initial, echoPut(initial));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    await r.click('[data-promote="n"]');
    expect(r.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ premoves: ['e7e8n'] });
  });

  it('steps back through the chain on the slider, returns to the end on a board tap, and removes', async () => {
    const r = mount(waiting(['g1h3', 'h3g5']), echoPut(waiting(['g1h3', 'h3g5'])));
    await r.flush();
    // One slider: the real move, then both premoves, standing at the chain's end.
    expect(slider(r)).toMatchObject({ value: '3', max: '3' });
    await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('2');
    expect(r.root.querySelector('[data-premove="1"]')?.getAttribute('aria-current')).toBe('true');
    expect(adapter.positions.at(-1)?.fen.split(' ')[0]).toBe(
      'rnbqkbnr/pppppppp/8/8/8/5P1N/PPPPP1PP/RNBQKB1R',
    );
    expect(adapter.movables.at(-1)?.colour).toBe('none');
    adapter.select('a4');
    await r.flush();
    expect(slider(r).value).toBe('3');
    await r.click('[data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove this premove?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      base: ['g1h3', 'h3g5'],
      premoves: ['g1h3'],
      expectedPly: 1,
    });
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(1);
    expect(slider(r)).toMatchObject({ value: '2', max: '2' });
  });

  it('asks before removing a premove with more after it, and Cancel keeps the chain', async () => {
    const r = mount(waiting(['g1h3', 'h3g5', 'g5e6']), echoPut(waiting(['g1h3', 'h3g5', 'g5e6'])));
    await r.flush();
    await r.click('[data-premove="1"]');
    await r.click('[data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove this premove and the 2 after it?');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    await r.click('[data-premove="2"]');
    await r.click('[data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove this premove and the next one?');
  });

  it('drops a confirmed Remove when the chain changed while the popup was open', async () => {
    const r = mount(waiting(['g1h3', 'h3g5']), echoPut(waiting(['g1h3', 'h3g5'])));
    await r.flush();
    await r.click('[data-premove="1"]');
    await r.click('[data-action="premove-remove"]');
    // Another device replaces the chain; confirming must not remove from the new one.
    FakeEventSource.instances[0]!.send('state', waiting(['b1c3', 'c3d5']), '1');
    await r.flush();
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(2);
  });

  it('fills the slider green up to the real position and blue on through the shown premove', async () => {
    const r = mount(waiting(['g1h3', 'h3g5']));
    await r.flush();
    // 1 real ply of 3: green to a third, blue to the knob at the end.
    expect(slider(r).style.getPropertyValue('--real')).toBe('33.333%');
    expect(slider(r).style.getPropertyValue('--at')).toBe('100%');
    await r.click('[data-action="prev"]');
    await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('1');
    expect(slider(r).classList.contains('premove')).toBe(false);
    expect(slider(r).style.getPropertyValue('--at')).toBe('33.333%');
  });

  it('slides from an earlier move straight back into the chain', async () => {
    const r = mount(waiting(['g1h3', 'h3g5']));
    await r.flush();
    const input = slider(r);
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(adapter.positions.at(-1)?.lastMove).toBeNull();
    // The premove stretch stays, so the track keeps its scale while you look back.
    expect(slider(r).max).toBe('3');
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(2);
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(r.root.querySelector('[data-premove="1"]')?.getAttribute('aria-current')).toBe('true');
    expect(adapter.highlights.at(-1)).toEqual(['g1', 'h3']);
  });

  it('shows the chain from another device when it arrives over the stream', async () => {
    const r = mount(waiting());
    await r.flush();
    FakeEventSource.instances[0]!.send('state', waiting(['b1c3']), '1');
    await r.flush();
    expect(r.root.querySelector('.move-list [data-premove="1"]')?.textContent).toBe('Nc3');
  });

  it('refuses a stale edit, shows the chain the other device made and says so', async () => {
    const r = mount(waiting(), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the premoves have changed' } },
        };
      if (call.method === 'GET') return { status: 200, body: waiting(['b1c3']) };
      return okRoute(waiting())(call);
    });
    await r.flush();
    adapter.drop('g1', 'h3');
    await r.flush();
    expect(document.querySelector('.toast')?.textContent).toContain(
      'Premoves changed on another device',
    );
    expect(r.root.querySelector('.move-list [data-premove="1"]')?.textContent).toBe('Nc3');
  });

  it('does not blame another device when the opponent moved first', async () => {
    const r = mount(waiting(), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the position has changed' } },
        };
      if (call.method === 'GET')
        return { status: 200, body: afterPlies(2, { viewerRole: 'white' }) };
      return okRoute(waiting())(call);
    });
    await r.flush();
    adapter.drop('g1', 'h3');
    await r.flush();
    expect(document.querySelector('.toast')).toBeNull();
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(0);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
  });

  it('toasts and buzzes when the tree was cancelled, and buzzes lightly when a premove played', async () => {
    const withTree = (premoveTree: string) => afterPlies(1, { viewerRole: 'white', premoveTree });
    const r = mount(withTree(treeText(pair('e7e5', 'g2g4'))));
    await r.flush();
    FakeEventSource.instances[0]!.send('state', afterPlies(3, { viewerRole: 'white' }), '3');
    await r.flush();
    expect(window.__tg!.haptics).toContain('impact:light');
    expect(document.querySelector('.toast')).toBeNull();

    const again = mount(withTree(treeText(pair('d7d5', 'e2e4'))));
    await again.flush();
    FakeEventSource.instances.at(-1)!.send('state', afterPlies(2, { viewerRole: 'white' }), '2');
    await again.flush();
    expect(document.querySelector('.toast')?.textContent).toContain('Premoves cancelled');
    expect(window.__tg!.haptics).toContain('notification:warning');
  });

  it('discards a promotion pick if the turn changed while the picker was open', async () => {
    const initial = gameDto({ fen: '4k3/4P3/8/8/8/8/8/K7 b - - 0 1', plyCount: 7, version: 7 });
    const r = mount(initial, echoPut(initial));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    // The bot replies while the picker is still open: it is now the viewer's own turn.
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen: '4k3/4P3/8/8/8/8/8/1K6 w - - 1 8', plyCount: 8, version: 8 }),
      '8',
    );
    await r.flush();
    await r.click('[data-promote="n"]');
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(r.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/moves'))).toHaveLength(0);
  });

  it('discards a promotion pick if the chain changed on another device while the picker was open', async () => {
    const fen = '4k3/4P3/8/8/8/8/8/K7 b - - 0 1';
    const initial = gameDto({ fen, plyCount: 7, version: 7 });
    const r = mount(initial, echoPut(initial));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    // Another device queues a king move: same ply and version, a different chain.
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen, plyCount: 7, version: 7, premoves: ['a1b1'] }),
      '7',
    );
    await r.flush();
    await r.click('[data-promote="n"]');
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(r.root.querySelector('.move-list [data-premove="1"]')?.textContent).toBe('Kb1');
  });

  it('offers no premove targets while the player’s own move is still sending', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    // The stream shows the move before its POST answers: it is now Black's turn.
    FakeEventSource.instances[0]!.send('state', afterPlies(1, { viewerRole: 'white' }), '1');
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('none');
    answer({ status: 200, body: afterPlies(1, { viewerRole: 'white' }) });
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
  });

  it('queues a premove made while the previous one is still saving, and saves it next', async () => {
    const answers: ((response: FakeResponse) => void)[] = [];
    const r = mount(
      waiting(),
      echoPut(waiting(), () => new Promise<FakeResponse>((resolve) => answers.push(resolve))),
    );
    await r.flush();
    adapter.drop('g1', 'h3');
    await r.flush();
    // The board stays live while the first premove saves, on the imagined board after Nh3.
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    expect(adapter.movables.at(-1)?.dests.get('h3')).toContain('g5');
    adapter.drop('h3', 'g5');
    await r.flush();
    const labels = () =>
      [...r.root.querySelectorAll('.move-list [data-premove]')].map((b) => b.textContent);
    expect(labels()).toEqual(['Nh3', 'Ng5']);
    const puts = () => r.calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    // One save at a time: the second waits for the first.
    expect(puts()).toEqual([{ base: [], premoves: ['g1h3'], expectedPly: 1 }]);
    answers[0]!({ status: 200, body: waiting(['g1h3']) });
    await r.flush();
    // Its echo doesn't drop the queued premove from the screen.
    expect(labels()).toEqual(['Nh3', 'Ng5']);
    // The next save compares against the chain the first one confirmed, which it was made on.
    expect(puts()).toEqual([
      { base: [], premoves: ['g1h3'], expectedPly: 1 },
      { base: ['g1h3'], premoves: ['g1h3', 'h3g5'], expectedPly: 1 },
    ]);
    answers[1]!({ status: 200, body: waiting(['g1h3', 'h3g5']) });
    await r.flush();
    expect(labels()).toEqual(['Nh3', 'Ng5']);
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('refuses a queued premove when another device changed the chain between saves', async () => {
    const answers: ((response: FakeResponse) => void)[] = [];
    const r = mount(waiting(), (call) => {
      if (call.method === 'PUT')
        return new Promise<FakeResponse>((resolve) => answers.push(resolve));
      if (call.method === 'GET') return { status: 200, body: waiting(['b1c3']) };
      return okRoute(waiting())(call);
    });
    await r.flush();
    adapter.drop('g1', 'h3');
    await r.flush();
    adapter.drop('h3', 'g5');
    await r.flush();
    answers[0]!({ status: 200, body: waiting(['g1h3']) });
    await r.flush();
    answers[1]!({
      status: 409,
      body: { error: { code: 'stale_state', message: 'the premoves have changed' } },
    });
    await r.flush();
    expect(document.querySelector('.toast')?.textContent).toContain(
      'Premoves changed on another device',
    );
    expect(r.root.querySelector('.move-list [data-premove="1"]')?.textContent).toBe('Nc3');
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(1);
  });

  it('rolls back the shown step along with the chain, and shows offline, when Remove fails on the network', async () => {
    const r = mount(waiting(['g1h3', 'h3g5']), (call) => {
      if (call.method === 'PUT') throw new TypeError('Failed to fetch');
      return okRoute(waiting(['g1h3', 'h3g5']))(call);
    });
    await r.flush();
    expect(slider(r).value).toBe('3');
    await r.click('[data-action="premove-remove"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(document.querySelector('.toast')?.textContent).toContain("You're offline");
    expect(r.root.querySelectorAll('.move-list [data-premove]')).toHaveLength(2);
    expect(slider(r).value).toBe('3');
  });
});
