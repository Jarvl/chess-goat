import {
  applyMove,
  encodePremoveBytes,
  encodePremoveTree,
  INITIAL_FEN,
  premoveTreeHash,
  type DraftNode,
  type GameDto,
  type MoveConfirmations,
  type MoveDto,
} from '@group-chess/shared';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '../src/state/session';
import { createTg } from '../src/tg/webapp';
import { Game } from '../src/ui/screens/Game';
import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse, FakeRoute } from './support/fakeFetch';
import { afterPlies, gameDto, pair, treeText } from './support/gameFixtures';
import { renderApp } from './support/render';
import { stubAdapter, type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
// The premove size limit, low enough in a test to be crossed by one pair.
const limits = vi.hoisted(() => ({ maxChars: 60_000 }));
vi.mock('@group-chess/shared', async () => {
  const actual = await vi.importActual<typeof import('@group-chess/shared')>('@group-chess/shared');
  return {
    ...actual,
    get PREMOVE_TREE_MAX_CHARS() {
      return limits.maxChars;
    },
  };
});
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
  limits.maxChars = 60_000;
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
    // Black waits, so the board is live for premoves, starting with White's possible moves.
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'white' });
  });

  it('sends a move as soon as it is dropped and applies the response', async () => {
    const r = mount(gameDto());
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

  it('shows the promotion chooser and sends the chosen piece', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
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
    const actions = [...r.root.querySelectorAll('.icon-bar button')].map((b) =>
      b.getAttribute('data-action'),
    );
    expect(actions).toEqual(['share', 'analyse', 'pgn']);
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="analyse"]')?.disabled).toBe(true);
  });

  it('shows the replay slider in a game still being played, and holds moves while it looks back', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
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
    await r.click('[data-action="rematch"]');
    const post = r.calls.at(-1);
    expect(post?.path).toBe(`/api/groups/${finished.group.id}/engine-games`);
    expect(post?.body).toEqual({ level: 'club', colour: 'random' });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'NextGameA1' });
  });

  it('lets spectators flip and share the viewed position', async () => {
    const r = mount(afterPlies(3, { viewerRole: 'spectator' }));
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
    const draw = r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')!;
    expect(draw.textContent).toBe('½Offered');
    expect(draw.disabled).toBe(true);
    expect(r.root.querySelectorAll('.icon-bar button')).toHaveLength(4);
  });

  it('dims Draw against the bot', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white', engineLevel: 'club' }));
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')?.disabled).toBe(
      true,
    );
  });

  it('reads Abort in the last slot before the second move, with Draw dimmed', async () => {
    const r = mount(gameDto({ viewerRole: 'white' }));
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
    const meta = r.root.querySelector('.game > .game-meta');
    expect(meta?.textContent).toBe('Chess Club · 1 day per move · Rated');
    expect(meta?.nextElementSibling?.classList.contains('player-bar')).toBe(true);
  });

  it('shows the pieces each side took, and +N only for the side ahead', async () => {
    // Black has taken a knight and a pawn; white has taken the queen.
    const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKB1R w KQkq - 0 5';
    const r = mount(gameDto({ fen, plyCount: 8, version: 8 }));
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

  it('holds the waiting move on the board and in the strip through a snapshot', async () => {
    const r = mount(afterPlies(2));
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
    const r = mount(initial);
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
    adapter.drop('a1', 'a8');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(adapter.positions.at(-1)).toMatchObject({ check: true, lastMove: ['a1', 'a8'] });
  });

  it('sends on drop against the bot under the default', async () => {
    const r = mount(gameDto({ engineLevel: 'casual' }));
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('holds a move against the bot when the setting is Always', async () => {
    wantPrefs.moveConfirmations = 'always';
    const r = mount(gameDto({ engineLevel: 'casual' }));
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('reads the setting at each drop, so a change mid-game applies to the next move', async () => {
    // The preference changes to 'never' after mount, before this drop.
    const r = mount(gameDto());
    prefs.value = { ...prefs.value, moveConfirmations: 'never' };
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
  });

  it('puts Cancel in the action row below 7.10', async () => {
    const r = mount(gameDto(), okRoute(gameDto()), '7.0');
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
    adapter.drop('e2', 'e4');
    await r.flush();
    // Telegram's own prompt guards closing while the move waits (this replaced the no-prompt rule).
    expect(window.__tg!.closingConfirmation).toBe(true);
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
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
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
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => ({
        status: 409,
        body: { error: { code: 'stale_state', message: 'the position has changed' } },
      })),
    );
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

// Conditional premoves (spec, Behaviour and The game screen). Dana plays Black against the viewer.
const DANA = { ...gameDto().black, name: 'Dana' };

/** A game after `ucis`, with consistent moves, fen, plyCount and version; Black is Dana. */
function played(ucis: string[], overrides: Partial<GameDto> = {}): GameDto {
  let fen = INITIAL_FEN;
  const moves: MoveDto[] = ucis.map((uci, index) => {
    const result = applyMove(fen, [], uci);
    if (!result.legal) throw new Error(`illegal fixture move ${uci}`);
    fen = result.fenAfter;
    return {
      ply: index + 1,
      uci,
      san: result.san,
      fenAfter: fen,
      playedAt: '2026-09-20T10:00:00.000Z',
    };
  });
  return gameDto({
    moves,
    plyCount: moves.length,
    version: moves.length,
    fen,
    black: DANA,
    ...overrides,
  });
}

/** 1.e4 e5 2.Nf3 Nc6: the viewer (White) is to move. */
const BEFORE_BC4 = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
/** …3.Bc4: Dana is to move. */
const ITALIAN = [...BEFORE_BC4, 'f1c4'];
/** 3…Nf6 4.Ng5 d5 5.exd5. */
const TWO_KNIGHTS = () => pair('g8f6', 'f3g5', pair('d7d5', 'e4d5'));

const premovePath = `/api/games/${GAME}/premoves`;
const putsOf = (r: ReturnType<typeof mount>) =>
  r.calls.filter((c) => c.method === 'PUT' && c.path === premovePath);
const movePostsOf = (r: ReturnType<typeof mount>) =>
  r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`);
const hashOf = (tree: DraftNode[]) => premoveTreeHash(encodePremoveBytes(tree));
const tokens = (r: ReturnType<typeof mount>) =>
  [...r.root.querySelectorAll('.lines-panel .lines-token')].map((b) => b.textContent);
const pill = (r: ReturnType<typeof mount>) =>
  r.root.querySelector('.premove-status .premove-pill')?.textContent;
const hint = (r: ReturnType<typeof mount>) =>
  r.root.querySelector('.premove-status .premove-hint')?.textContent;
const placement = () => adapter.positions.at(-1)?.fen.split(' ')[0];
const toastText = () => document.querySelector('.toast')?.textContent;
/** Answers a PUT with the tree it saved, on top of `initial`. */
const savesTree =
  (initial: GameDto, onPut?: FakeRoute): FakeRoute =>
  (call) => {
    if (call.method === 'PUT' && call.path === premovePath) {
      if (onPut) return onPut(call);
      return {
        status: 200,
        body: { ...initial, premoveTree: (call.body as { tree: string }).tree },
      };
    }
    return okRoute(initial)(call);
  };

describe('Game premoves with move confirmations on', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });

  it('builds premoves on the waiting move and sends them with it in one request', async () => {
    const initial = played([]);
    const r = mount(
      initial,
      okRoute(initial, () => ({ status: 200, body: played(['e2e4']) })),
    );
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(placement()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('e4');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    // The board is live for Dana's move after it, then for the reply.
    expect(adapter.movables.at(-1)?.colour).toBe('black');
    adapter.drop('e7', 'e5');
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    // An opponent move without a reply is no premove yet.
    expect(window.__tg!.mainButton.text).toBe('Confirm move');
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Confirm move + 1 premove',
      visible: true,
    });
    expect(adapter.highlights.at(-1)).toEqual(['g1', 'f3']);
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(1);
    expect(movePostsOf(r)[0]?.body).toMatchObject({
      uci: 'e2e4',
      expectedPly: 0,
      premoveTree: encodePremoveTree([pair('e7e5', 'g1f3')]),
    });
    expect(putsOf(r)).toHaveLength(0);
    // Our own move coming back is no discarded draft.
    expect(toastText()).toBeUndefined();
  });

  it('counts every pair in the button', async () => {
    const r = mount(played(['e2e4', 'e7e5']));
    adapter.drop('g1', 'f3');
    await r.flush();
    for (const [orig, dest] of [
      ['b8', 'c6'],
      ['f1', 'c4'],
    ] as const) {
      adapter.drop(orig, dest);
      await r.flush();
    }
    await r.click('.lines-panel [data-path=""]');
    for (const [orig, dest] of [
      ['d7', 'd6'],
      ['d2', 'd4'],
    ] as const) {
      adapter.drop(orig, dest);
      await r.flush();
    }
    expect(window.__tg!.mainButton.text).toBe('Confirm move + 2 premoves');
  });

  it('confirms premoves on the opponent’s turn with one PUT against the server tree', async () => {
    const initial = played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) });
    const r = mount(initial, savesTree(initial));
    expect(window.__tg!.mainButton.visible).toBe(false);
    await r.click('.lines-panel [data-path=""]');
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm premoves', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(r.app.router.suppressTabs.value).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    expect(putsOf(r)[0]?.body).toEqual({
      baseHash: await hashOf([pair('d7d5', 'e4d5')]),
      tree: encodePremoveTree([pair('d7d5', 'e4d5'), pair('e7e5', 'g1f3')]),
      expectedPly: 1,
    });
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(tokens(r)).toEqual(['d5', 'exd5', 'e5', 'Nf3']);
    expect(pill(r)).toBe('2 premoves saved');
  });

  it('discards the draft on Cancel and sends nothing', async () => {
    const r = mount(played(['e2e4']));
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    window.__tg!.clickSecondary();
    await r.flush();
    expect(tokens(r)).toEqual([]);
    expect(r.calls).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(placement()).toBe(played(['e2e4']).fen.split(' ')[0]);
  });

  it('labels the in-page buttons as Telegram’s below 7.10', async () => {
    const r = mount(played(['e2e4']), okRoute(played(['e2e4'])), '7.0');
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(window.__tg!.mainButton.text).toBe('Confirm premoves');
    expect(r.root.querySelector('.toolbar [data-action="cancel-move"]')?.textContent).toBe(
      'Cancel',
    );
  });

  it('asks before replacing a reply, previews it, and Cancel puts everything back', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mount(initial);
    await r.click('.lines-panel [data-path="g8f6"]');
    const afterNf6 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R';
    expect(placement()).toBe(afterNf6);
    adapter.drop('b1', 'c3');
    await r.flush();
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      message: 'Replace 4.Ng5 with 4.Nc3?\nThe 2 moves after Ng5 will be removed too.',
      buttons: [
        { id: 'cancel', type: 'cancel' },
        { id: 'confirm', text: 'Replace' },
      ],
    });
    // The board, the tree and the strip already show the new move.
    expect(placement()).toBe('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R');
    expect(tokens(r)).toEqual(['Nf6', 'Nc3']);
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(placement()).toBe(afterNf6);
    expect(tokens(r)).toEqual(['Nf6', 'Ng5', 'd5', 'exd5']);
    expect(window.__tg!.mainButton.visible).toBe(false);

    adapter.drop('b1', 'c3');
    await r.flush();
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(tokens(r)).toEqual(['Nf6', 'Nc3']);
    expect(window.__tg!.mainButton.text).toBe('Confirm premoves');
    expect(r.calls).toHaveLength(0);
  });

  it('asks before replacing the waiting move when premoves hang off it', async () => {
    const r = mount(played(BEFORE_BC4));
    adapter.drop('f1', 'c4');
    await r.flush();
    adapter.drop('g8', 'f6');
    await r.flush();
    adapter.drop('f3', 'g5');
    await r.flush();
    expect(slider(r)).toMatchObject({ value: '7', max: '7' });
    for (let step = 0; step < 3; step += 1) await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('4');
    expect(hint(r)).toBe('Before your 3.Bc4 · play another move to replace it');
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    adapter.drop('d2', 'd4');
    await r.flush();
    expect(window.__tg!.popups.at(-1)?.message).toBe(
      'Replace 3.Bc4 with 3.d4?\nYour premove after Bc4 will be removed too.',
    );
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('d4');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('Bc4');
    expect(window.__tg!.mainButton.text).toBe('Confirm move + 1 premove');
    expect(slider(r).value).toBe('4');

    adapter.drop('d2', 'd4');
    await r.flush();
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('d4');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.text).toBe('Confirm move');
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'd2d4', expectedPly: 4, premoveTree: '' });
  });

  it('replaces a waiting move without premoves at once', async () => {
    const r = mount(played(BEFORE_BC4));
    adapter.drop('f1', 'c4');
    await r.flush();
    await r.click('[data-action="prev"]');
    adapter.drop('d2', 'd4');
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('d4');
    expect(slider(r).value).toBe('5');
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'd2d4' });
  });

  it('steps back from the tree to the position before the waiting move, then into history', async () => {
    const r = mount(played(BEFORE_BC4));
    adapter.drop('f1', 'c4');
    await r.flush();
    expect(slider(r)).toMatchObject({ value: '5', max: '5' });
    await r.click('[data-action="prev"]');
    // The position before the waiting move: still the player's to change.
    expect(placement()).toBe(played(BEFORE_BC4).fen.split(' ')[0]);
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('3');
    expect(adapter.movables.at(-1)?.colour).toBe('none');
    expect(hint(r)).toBe('An earlier move · tap the board to go back');
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('Bc4');
    // A tap on the board comes back to where the player was.
    adapter.select('a3');
    await r.flush();
    expect(slider(r).value).toBe('5');
    expect(window.__tg!.mainButton.text).toBe('Confirm move');
  });

  it('asks before removing a premove and the moves after it, and says what went', async () => {
    const r = mount(played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) }));
    await r.click('.lines-panel [data-path="g8f6,f3g5,d7d5,e4d5"]');
    adapter.drop('c6', 'a5');
    await r.flush();
    await r.click('.lines-panel [data-path="g8f6"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      message: 'Remove 3…Nf6 and the 4 moves after it?',
      buttons: [
        { id: 'cancel', type: 'cancel' },
        { id: 'confirm', type: 'destructive', text: 'Remove' },
      ],
    });
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(tokens(r)).toEqual(['Nf6', 'Ng5', 'd5', 'exd5', 'Na5']);
    await r.click('.move-list [data-action="premove-remove"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(toastText()).toBe('Removed 3…Nf6 and 4 moves after it');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.text).toBe('Confirm premoves');
    expect(r.calls).toHaveLength(0);
  });

  it('names a removed move alone, or with the move after it', async () => {
    const r = mount(played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) }));
    await r.click('.lines-panel [data-path="g8f6,f3g5,d7d5,e4d5"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove 5.exd5?');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    await r.click('.lines-panel [data-path="g8f6,f3g5,d7d5"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove 4…d5 and the move after it?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(toastText()).toBe('Removed 4…d5 and 1 move after it');
  });

  it('discards an open draft when the opponent moves', async () => {
    const r = mount(played(['e2e4']));
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    FakeEventSource.instances[0]!.send('state', played(['e2e4', 'c7c5']), '2');
    await r.flush();
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.root.querySelector('.move-list [data-waiting]')).toBeNull();

    // Without premove changes there is nothing to say.
    const again = mount(played(['e2e4']));
    FakeEventSource.instances.at(-1)!.send('state', played(['e2e4', 'c7c5']), '2');
    await again.flush();
    expect(toastText()).toBeUndefined();
  });

  it('keeps the waiting move and the draft when Telegram minimises the app', async () => {
    const r = mount(played([]));
    adapter.drop('e2', 'e4');
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    await r.flush();
    expect(adapter.restored).toBe(restored);
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('e4');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Confirm move + 1 premove',
      visible: true,
    });
    expect(r.calls).toHaveLength(0);
  });

  it('opens the picker for promotions in the tree, for either side, and keeps the piece', async () => {
    const initial = gameDto({ fen: '7k/4P3/8/8/8/8/3p4/K7 b - - 0 1', plyCount: 9, version: 9 });
    const r = mount(initial, savesTree(initial));
    adapter.drop('d2', 'd1');
    await r.flush();
    expect(r.root.querySelector('.promotion [data-promote="n"]')?.classList.contains('black')).toBe(
      true,
    );
    await r.click('[data-promote="n"]');
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.root.querySelector('.promotion [data-promote="q"]')?.classList.contains('white')).toBe(
      true,
    );
    await r.click('[data-promote="q"]');
    window.__tg!.clickMain();
    await r.flush();
    expect((putsOf(r)[0]?.body as { tree: string }).tree).toBe(
      encodePremoveTree([pair('d2d1n', 'e7e8q')]),
    );
  });

  it('discards a promotion pick if the game moved on while the picker was open', async () => {
    const initial = gameDto({ fen: '7k/4P3/8/8/8/8/3p4/K7 b - - 0 1', plyCount: 9, version: 9 });
    const r = mount(initial, savesTree(initial));
    adapter.drop('d2', 'd1');
    await r.flush();
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen: '6k1/4P3/8/8/8/8/3p4/K7 w - - 1 10', plyCount: 10, version: 10 }),
      '10',
    );
    await r.flush();
    await r.click('[data-promote="n"]');
    expect(tokens(r)).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it('discards a promotion pick if the tree changed on another device while the picker was open', async () => {
    const fen = '7k/4P3/8/8/8/8/3p4/K7 b - - 0 1';
    const initial = gameDto({ fen, plyCount: 9, version: 9 });
    const r = mount(initial, savesTree(initial));
    adapter.drop('d2', 'd1');
    await r.flush();
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ fen, plyCount: 9, version: 9, premoveTree: treeText(pair('h8g8', 'a1b1')) }),
      '9',
    );
    await r.flush();
    await r.click('[data-promote="n"]');
    expect(tokens(r)).toEqual(['Kg8', 'Kb1']);
    expect(r.calls).toHaveLength(0);
  });

  it('refuses a confirm the server calls stale, reloads and says so', async () => {
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT')
        return { status: 409, body: { error: { code: 'stale_state', message: 'changed' } } };
      if (call.method === 'GET')
        return {
          status: 200,
          body: played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) }),
        };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('says the draft went when the opponent moved while Confirm premoves was on its way', async () => {
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the position has changed' } },
        };
      if (call.method === 'GET') return { status: 200, body: played(['e2e4', 'c7c5']) };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('says nothing about the draft when the game ended while Confirm premoves was on its way', async () => {
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the game is over' } },
        };
      if (call.method === 'GET')
        return {
          status: 200,
          body: played(['e2e4'], { status: 'finished', result: '1-0', endReason: 'resignation' }),
        };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBeUndefined();
  });

  it('keeps an oversize draft on screen and sends nothing', async () => {
    limits.maxChars = 4;
    const r = mount(played([]));
    adapter.drop('e2', 'e4');
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    expect(window.__tg!.mainButton.text).toBe('Confirm move + 1 premove');
  });
});

describe('Game premoves while the draft is on its way', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });

  it('offers no ✕ and removes nothing while a confirmed move retries', async () => {
    vi.useFakeTimers();
    const initial = played([]);
    const r = mount(
      initial,
      okRoute(initial, () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100);
    adapter.drop('e7', 'e5');
    await vi.advanceTimersByTimeAsync(100);
    adapter.drop('g1', 'f3');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).not.toBeNull();
    window.__tg!.clickMain();
    await vi.advanceTimersByTimeAsync(100);
    expect(window.__tg!.mainButton.text).toBe('Retry');
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).toBeNull();
    expect(r.root.querySelector('.move-list [data-action="premove-remove"]')).toBeNull();
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    expect(window.__tg!.popups).toHaveLength(0);
  });

  it('offers no ✕ while Confirm premoves is on its way', async () => {
    const initial = played(['e2e4']);
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      initial,
      savesTree(initial, () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).toBeNull();
    expect(r.root.querySelector('.move-list [data-action="premove-remove"]')).toBeNull();
    answer({ status: 200, body: { ...initial, premoveTree: treeText(pair('e7e5', 'g1f3')) } });
    await r.flush();
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).not.toBeNull();
  });
});

describe('Game premoves with move confirmations on, too big for the server', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });

  it('puts a move refused with 413 back to waiting, with its draft and without reloading', async () => {
    const initial = played([]);
    const r = mount(
      initial,
      okRoute(initial, () => ({ status: 413, body: undefined })),
    );
    adapter.drop('e2', 'e4');
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(movePostsOf(r)).toHaveLength(1);
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(r.root.querySelector('.move-list [data-waiting]')?.textContent).toBe('e4');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Confirm move + 1 premove',
      visible: true,
    });
  });
});

describe('Game premoves with move confirmations off', () => {
  it('saves each completed pair on its own, one save at a time, never an unanswered move', async () => {
    const initial = played(['e2e4']);
    const answers: ((response: FakeResponse) => void)[] = [];
    const r = mount(
      initial,
      savesTree(initial, () => new Promise<FakeResponse>((resolve) => answers.push(resolve))),
    );
    adapter.drop('e7', 'e5');
    await r.flush();
    expect(putsOf(r)).toHaveLength(0);
    expect(pill(r)).toBe('Dana to move');
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r).map((c) => c.body)).toEqual([
      {
        baseHash: await hashOf([]),
        tree: encodePremoveTree([pair('e7e5', 'g1f3')]),
        expectedPly: 1,
      },
    ]);
    // The board stays live while it saves; the next pair waits for the save.
    await r.click('.lines-panel [data-path=""]');
    adapter.drop('d7', 'd5');
    await r.flush();
    adapter.drop('e4', 'd5');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    expect(tokens(r)).toEqual(['e5', 'Nf3', 'd5', 'exd5']);
    const first = encodePremoveTree([pair('e7e5', 'g1f3')]);
    answers[0]!({ status: 200, body: { ...initial, premoveTree: first } });
    await r.flush();
    expect(tokens(r)).toEqual(['e5', 'Nf3', 'd5', 'exd5']);
    expect(putsOf(r).map((c) => c.body)).toEqual([
      { baseHash: await hashOf([]), tree: first, expectedPly: 1 },
      {
        baseHash: await hashOf([pair('e7e5', 'g1f3')]),
        tree: encodePremoveTree([pair('e7e5', 'g1f3'), pair('d7d5', 'e4d5')]),
        expectedPly: 1,
      },
    ]);
    answers[1]!({
      status: 200,
      body: { ...initial, premoveTree: (putsOf(r)[1]!.body as { tree: string }).tree },
    });
    await r.flush();
    expect(putsOf(r)).toHaveLength(2);
    expect(pill(r)).toBe('2 premoves saved');
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('sends an edit made after the opponent moved against the new position', async () => {
    const answers: ((response: FakeResponse) => void)[] = [];
    const after = played(['e2e4', 'c7c5', 'g1f3']);
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT' && call.path === premovePath)
        return new Promise<FakeResponse>((resolve) => answers.push(resolve));
      if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves`)
        return { status: 200, body: after };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    // Dana answers 1…c5 while that save runs, and the player replies 2.Nf3 …
    FakeEventSource.instances[0]!.send('state', played(['e2e4', 'c7c5']), '2');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    // … then builds a premove on the new position.
    adapter.drop('d7', 'd6');
    await r.flush();
    adapter.drop('d2', 'd4');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    answers[0]!({
      status: 409,
      body: { error: { code: 'stale_state', message: 'the position has changed' } },
    });
    await r.flush();
    expect(putsOf(r).map((c) => c.body)).toEqual([
      {
        baseHash: await hashOf([]),
        tree: encodePremoveTree([pair('e7e5', 'g1f3')]),
        expectedPly: 1,
      },
      {
        baseHash: await hashOf([]),
        tree: encodePremoveTree([pair('d7d6', 'd2d4')]),
        expectedPly: 3,
      },
    ]);
    expect(tokens(r)).toEqual(['d6', 'd4']);
    expect(toastText()).toBeUndefined();
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  it('keeps the base a save moved forward when a replace popup opened meanwhile is cancelled', async () => {
    const initial = played(['e2e4']);
    const answers: ((response: FakeResponse) => void)[] = [];
    const r = mount(
      initial,
      savesTree(initial, () => new Promise<FakeResponse>((resolve) => answers.push(resolve))),
    );
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    // While T1 saves, a different reply opens the replace popup …
    await r.click('.lines-panel [data-path="e7e5"]');
    adapter.drop('b1', 'c3');
    await r.flush();
    expect(window.__tg!.popups.at(-1)?.message).toBe('Replace 2.Nf3 with 2.Nc3?');
    // … the save lands, and then the popup is cancelled.
    const t1 = encodePremoveTree([pair('e7e5', 'g1f3')]);
    answers[0]!({ status: 200, body: { ...initial, premoveTree: t1 } });
    await r.flush();
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    await r.click('.lines-panel [data-path=""]');
    adapter.drop('d7', 'd5');
    await r.flush();
    adapter.drop('e4', 'd5');
    await r.flush();
    expect(putsOf(r)[1]?.body).toEqual({
      baseHash: await hashOf([pair('e7e5', 'g1f3')]),
      tree: encodePremoveTree([pair('e7e5', 'g1f3'), pair('d7d5', 'e4d5')]),
      expectedPly: 1,
    });
  });

  it('never saves an unsaved change over a tree another device saved meanwhile', async () => {
    limits.maxChars = 4;
    const initial = played(['e2e4']);
    const theirs = played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) });
    const r = mount(initial, (call) => {
      if (call.method === 'PUT')
        return { status: 409, body: { error: { code: 'stale_state', message: 'changed' } } };
      if (call.method === 'GET') return { status: 200, body: theirs };
      return okRoute(initial)(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(0); // too big: kept on screen, unsaved
    FakeEventSource.instances[0]!.send('state', theirs, '1');
    await r.flush();
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    limits.maxChars = 60_000;
    await r.click('.lines-panel [data-path=""]');
    adapter.drop('c7', 'c5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    // The change was made on the empty tree, so that is what the save names as its base.
    expect(putsOf(r)[0]?.body).toMatchObject({ baseHash: await hashOf([]), expectedPly: 1 });
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
  });

  it('keeps an unanswered opponent move on the device through a save', async () => {
    const initial = played(['e2e4']);
    const r = mount(initial, savesTree(initial));
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    adapter.drop('b8', 'c6');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    expect(tokens(r)).toEqual(['e5', 'Nf3', 'Nc6']);
    expect(hint(r)).toBe('Your reply to 2…Nc6');
  });

  it('saves a confirmed replacement and a confirmed removal', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mount(initial, savesTree(initial));
    await r.click('.lines-panel [data-path="g8f6"]');
    adapter.drop('b1', 'c3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(0);
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect((putsOf(r)[0]?.body as { tree: string }).tree).toBe(
      encodePremoveTree([pair('g8f6', 'b1c3')]),
    );
    await r.click('.lines-panel [data-path="g8f6"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Remove 3…Nf6 and the move after it?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(putsOf(r)[1]?.body).toEqual({
      baseHash: await hashOf([pair('g8f6', 'b1c3')]),
      tree: '',
      expectedPly: 5,
    });
  });

  it('refuses a stale save, shows the tree the other device made and says so', async () => {
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the premoves have changed' } },
        };
      if (call.method === 'GET')
        return {
          status: 200,
          body: played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) }),
        };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
  });

  it('says the change went, not another device, when the opponent moved first', async () => {
    const r = mount(played(['e2e4']), (call) => {
      if (call.method === 'PUT')
        return {
          status: 409,
          body: { error: { code: 'stale_state', message: 'the position has changed' } },
        };
      if (call.method === 'GET') return { status: 200, body: played(['e2e4', 'e7e5']) };
      return okRoute(played(['e2e4']))(call);
    });
    await r.flush();
    adapter.drop('c7', 'c5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
  });

  it('puts the tree back and says offline when a removal fails on the network', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mount(initial, (call) => {
      if (call.method === 'PUT') throw new TypeError('Failed to fetch');
      return okRoute(initial)(call);
    });
    await r.flush();
    await r.click('.lines-panel [data-path="g8f6"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(toastText()).toBe("You're offline");
    expect(tokens(r)).toEqual(['Nf6', 'Ng5', 'd5', 'exd5']);
  });

  it('drops a confirmed removal when the tree changed while the popup was open', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mount(initial, savesTree(initial));
    await r.click('.lines-panel [data-path="g8f6"]');
    await r.click('.lines-panel [data-action="premove-remove"]');
    FakeEventSource.instances[0]!.send(
      'state',
      played(ITALIAN, { premoveTree: treeText(pair('d7d6', 'd2d4')) }),
      '5',
    );
    await r.flush();
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(putsOf(r)).toHaveLength(0);
    expect(tokens(r)).toEqual(['d6', 'd4']);
  });

  it('keeps an oversize change on screen', async () => {
    limits.maxChars = 4;
    const initial = played(['e2e4']);
    const r = mount(initial, savesTree(initial));
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
  });

  it('treats a 413 from the server like an oversize tree, without reloading', async () => {
    const initial = played(['e2e4']);
    const r = mount(
      initial,
      savesTree(initial, () => ({ status: 413, body: undefined })),
    );
    adapter.drop('e7', 'e5');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    expect(putsOf(r)).toHaveLength(1);
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
  });

  it('offers no premoves while the player’s own move is still sending', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      played([]),
      okRoute(played([]), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    adapter.drop('e2', 'e4');
    await r.flush();
    // The stream shows the move before its POST answers: it is now Dana's turn.
    FakeEventSource.instances[0]!.send('state', played(['e2e4']), '1');
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('none');
    answer({ status: 200, body: played(['e2e4']) });
    await r.flush();
    // Then the board is live for Dana's possible moves.
    expect(adapter.movables.at(-1)?.colour).toBe('black');
  });
});

describe('Game premove board and status line', () => {
  it('shows a pill and a hint for each case', async () => {
    wantPrefs.moveConfirmations = 'people';
    const own = mount(played(BEFORE_BC4));
    expect([pill(own), hint(own)]).toEqual(['Your move', 'Play your move']);

    const waiting = mount(played(['e2e4']));
    expect([pill(waiting), hint(waiting)]).toEqual(['Dana to move', 'Play a move Dana might make']);

    const drafting = mount(played(ITALIAN));
    adapter.drop('g8', 'f6');
    await drafting.flush();
    expect([pill(drafting), hint(drafting)]).toEqual(['Draft', 'Your reply to 3…Nf6']);

    const saved = mount(
      played(ITALIAN, {
        premoveTree: treeText(TWO_KNIGHTS(), pair('f8c5', 'c2c3')),
      }),
    );
    expect([pill(saved), hint(saved)]).toEqual([
      '3 premoves saved',
      'Play another of Dana’s moves to branch',
    ]);
    await saved.click('.lines-panel [data-path="g8f6"]');
    expect(hint(saved)).toBe('Play another move to replace 4.Ng5');

    const one = mount(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    expect(pill(one)).toBe('1 premove saved');
  });

  it('roots the Lines panel at Now, or at the waiting move', async () => {
    wantPrefs.moveConfirmations = 'people';
    const r = mount(played(BEFORE_BC4));
    expect(r.root.querySelector('.lines-panel')).toBeNull();
    adapter.drop('f1', 'c4');
    await r.flush();
    expect(r.root.querySelector('.lines-root')?.textContent).toBe('3.Bc4your move');

    const now = mount(played(['e2e4']));
    expect(now.root.querySelector('.lines-root')?.textContent).toBe('Nowcurrent position');
  });

  it('tells the player to move first when they touch the opponent’s pieces', async () => {
    const r = mount(played([]));
    adapter.select('e2');
    await r.flush();
    expect(toastText()).toBeUndefined();
    adapter.select('e7');
    await r.flush();
    expect(toastText()).toBe(
      'Play your own move first. Then you can play the moves Dana might make.',
    );
  });

  it('says nothing when a tap captures an opponent piece with the selected piece', async () => {
    const r = mount(played(['e2e4', 'd7d5']));
    // Chessground reports both taps of a click-click move before the move itself.
    adapter.select('e4');
    adapter.select('d5');
    adapter.drop('e4', 'd5', true);
    await r.flush();
    expect(toastText()).toBeUndefined();
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'e4d5' });
  });

  it('still nudges when the selected piece cannot take the tapped one', async () => {
    const r = mount(played(['e2e4', 'd7d5']));
    adapter.select('g1');
    adapter.select('d5');
    await r.flush();
    expect(toastText()).toBe(
      'Play your own move first. Then you can play the moves Dana might make.',
    );
  });

  it('fills the slider green up to the real position and blue on through the shown premove', async () => {
    const r = mount(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    // 5 real plies of 7: the knob stands on the real position.
    expect(slider(r)).toMatchObject({ value: '5', max: '7' });
    expect(slider(r).style.getPropertyValue('--real')).toBe('71.429%');
    expect(slider(r).style.getPropertyValue('--at')).toBe('71.429%');
    await r.click('.move-list [data-line="1"]');
    expect(slider(r).value).toBe('7');
    expect(slider(r).classList.contains('premove')).toBe(true);
    expect(slider(r).style.getPropertyValue('--at')).toBe('100%');
    expect(adapter.highlights.at(-1)).toEqual(['f3', 'g5']);
    expect(r.root.querySelector('.board-wrap')?.classList.contains('premove')).toBe(true);
  });

  it('slides from an earlier move straight back into the tree', async () => {
    const r = mount(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    const input = slider(r);
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(adapter.positions.at(-1)?.lastMove).toBeNull();
    expect(slider(r).max).toBe('7');
    input.value = '6';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(r.root.querySelector('[data-line="0"]')?.getAttribute('aria-current')).toBe('true');
    expect(adapter.highlights.at(-1)).toEqual(['g8', 'f6']);
    expect(adapter.movables.at(-1)?.colour).toBe('white');
  });

  it('shows the tree from another device when it arrives over the stream', async () => {
    const r = mount(played(ITALIAN));
    FakeEventSource.instances[0]!.send(
      'state',
      played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }),
      '5',
    );
    await r.flush();
    expect(tokens(r)).toEqual(['Nf6', 'Ng5']);
  });

  it('shares the real position, never a premove one', async () => {
    const r = mount(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    await r.click('[data-action="share"]');
    await r.click('.lines-panel [data-path="g8f6,f3g5"]');
    await r.click('[data-action="share"]');
    const shares = r.calls.filter((c) => c.path === `/api/games/${GAME}/share`);
    expect(shares.map((c) => c.body)).toEqual([{ ply: 5 }, { ply: 5 }]);
  });

  it('toasts and buzzes when the tree was cancelled, and buzzes lightly when a premove played', async () => {
    const withTree = (premoveTree: string) => afterPlies(1, { viewerRole: 'white', premoveTree });
    const r = mount(withTree(treeText(pair('e7e5', 'g2g4'))));
    FakeEventSource.instances[0]!.send('state', afterPlies(3, { viewerRole: 'white' }), '3');
    await r.flush();
    expect(window.__tg!.haptics).toContain('impact:light');
    expect(document.querySelector('.toast')).toBeNull();

    const again = mount(withTree(treeText(pair('d7d5', 'e2e4'))));
    FakeEventSource.instances.at(-1)!.send('state', afterPlies(2, { viewerRole: 'white' }), '2');
    await again.flush();
    expect(document.querySelector('.toast')?.textContent).toContain('Premoves cancelled');
    expect(window.__tg!.haptics).toContain('notification:warning');
  });
});

// Leaving with an unconfirmed draft (Move confirmations spec, Sending it).
describe('Game leaving with an unconfirmed draft', () => {
  const LEAVE_TITLE = 'Leave this game?';
  const mountInGame = (initial: GameDto) => {
    const r = mount(initial);
    r.app.router.land('games', { name: 'game', gameId: GAME }, [{ name: 'games' }]);
    return r;
  };
  const dropAll = async (r: ReturnType<typeof mount>, moves: [string, string][]) => {
    for (const [orig, dest] of moves) {
      adapter.drop(orig as never, dest as never);
      await r.flush();
    }
  };
  const leaveByBack = async (r: ReturnType<typeof mount>, answer: 'confirm' | 'cancel') => {
    window.__tg!.clickBack();
    await r.flush();
    const popup = window.__tg!.popups.at(-1);
    window.__tg!.answerPopup(answer);
    await r.flush();
    return popup;
  };

  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
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

  it('lets go of the guard and the closing confirmation when the screen goes', async () => {
    const r = mountInGame(played([]));
    await dropAll(r, [['e2', 'e4']]);
    expect(r.app.router.leaveGuard).not.toBeNull();
    render(null, r.root);
    await r.flush();
    expect(r.app.router.leaveGuard).toBeNull();
    expect(window.__tg!.closingConfirmation).toBe(false);
  });

  it('does not ask, or hold closing, once Confirm move is tapped and the move is sending', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const initial = played([]);
    const r = mount(
      initial,
      okRoute(initial, () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
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
    const r = mount(initial, (call) => {
      if (call.method === 'PUT' && call.path === `/api/games/${GAME}/premoves`)
        return new Promise<FakeResponse>((resolve) => (answer = resolve));
      return { status: 200, body: initial };
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
    wantPrefs.moveConfirmations = 'never';
    let answer: (response: FakeResponse) => void = () => undefined;
    const initial = played(['e2e4']);
    const r = mount(
      initial,
      savesTree(initial, () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
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
