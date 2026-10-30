import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse, FakeRoute } from './support/fakeFetch';
import { afterPlies, gameDto } from './support/gameFixtures';
import {
  cleanupGameScreen,
  GAME,
  gameRoutes,
  mountGame,
  resetGameScreen,
  slider,
  staleState,
} from './support/gameScreen';

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

describe('Game', () => {
  it('renders the players, clocks and moves from the launch data and opens the stream', async () => {
    const r = mountGame(afterPlies(2, { viewerRole: 'black' }));
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
    const r = mountGame(gameDto());
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
    const r = mountGame(gameDto(), {
      route: gameRoutes(gameDto(), {
        move: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
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
    const r = mountGame(quiet);
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
    const r = mountGame(gameDto(), {
      route: gameRoutes(afterPlies(1, { viewerRole: 'white' }), { move: () => staleState() }),
    });
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
    const r = mountGame(
      gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }),
    );
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
    const r = mountGame(afterPlies(2, { viewerRole: 'white' }));
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
    const r = mountGame(finished, { route: gameRoutes(finished), version: '7.0' });
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
    const r = mountGame(finished, { route: gameRoutes(finished), version: '7.0' });
    const white = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const black = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(r.root.querySelector('.result-card')).toBeNull();
    expect(r.root.querySelector('.clock')).toBeNull();
    expect(black.querySelector('.result-tag')?.textContent).toBe('Won');
    expect(black.querySelector('.sub')?.textContent).toBe('Checkmate');
    expect(black.querySelector('.rating')?.textContent).toBe('1500? → 1662?');
    expect(white.querySelector('.result-tag')?.textContent).toBe('Lost');
    expect(white.querySelector('.sub')).toBeNull();
  });

  // Which tag and reason each side gets is sideResult's, tested in result.test.ts.
  it('offers no rematch for a voided game', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'white',
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      voided: true,
    });
    const r = mountGame(finished, { route: gameRoutes(finished), version: '7.0' });
    expect(r.root.querySelector('[data-action="rematch"]')).toBeNull();
  });

  it('gives spectators of a finished game share, analyze and PGN, with Analyze dimmed without a link', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'spectator',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
    });
    const r = mountGame(finished, { route: gameRoutes(finished), version: '7.0' });
    const actions = [...r.root.querySelectorAll('.icon-bar button')].map((b) =>
      b.getAttribute('data-action'),
    );
    expect(actions).toEqual(['share', 'analyse', 'pgn']);
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="analyse"]')?.disabled).toBe(true);
  });

  it('shows the replay slider in a game still being played, and holds moves while it looks back', async () => {
    const r = mountGame(afterPlies(2, { viewerRole: 'white' }));
    expect(slider(r).max).toBe('2');
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'white' });
    await r.click('[data-action="prev"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['f2', 'f3']);
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'none' });
    await r.click('[data-action="next"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['e7', 'e5']);
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'white' });
  });

  it('shows the slider before the first move, with nothing to step through', async () => {
    const r = mountGame(gameDto({ viewerRole: 'white' }));
    expect(slider(r).max).toBe('0');
    expect(slider(r).disabled).toBe(true);
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
      return gameRoutes(finished)(call);
    };
    const r = mountGame(finished, { route: route, version: '7.0' });
    await r.click('[data-action="rematch"]');
    const post = r.calls.at(-1);
    expect(post?.path).toBe(`/api/groups/${finished.group.id}/engine-games`);
    expect(post?.body).toEqual({ level: 'club', colour: 'random' });
    // Opened in place like a hop, so the switcher strip keeps its order and adds the new game.
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'NextGameA1', hop: true });
  });

  it('lets spectators flip and share the viewed position', async () => {
    const r = mountGame(afterPlies(3, { viewerRole: 'spectator' }));
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
    const r = mountGame(afterPlies(2, { viewerRole: 'white' }));
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
    const r = mountGame(
      afterPlies(2, { viewerRole: 'white', drawOffer: { by: 'white', atPly: 2 } }),
    );
    const draw = r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')!;
    expect(draw.textContent).toBe('½Offered');
    expect(draw.disabled).toBe(true);
    expect(r.root.querySelectorAll('.icon-bar button')).toHaveLength(4);
  });

  it('dims Draw against the bot', async () => {
    const r = mountGame(afterPlies(2, { viewerRole: 'white', engineLevel: 'club' }));
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="offer-draw"]')?.disabled).toBe(
      true,
    );
  });

  it('reads Abort in the last slot before the second move, with Draw dimmed', async () => {
    const r = mountGame(gameDto({ viewerRole: 'white' }));
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
    const r = mountGame(afterPlies(2, { viewerRole: 'white' }));
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
    const r = mountGame(afterPlies(2, { viewerRole: 'white' }));
    const meta = r.root.querySelector('.game > .game-meta');
    expect(meta?.textContent).toBe('Chess Club · 1 day per move · Rated');
    expect(meta?.nextElementSibling?.classList.contains('player-bar')).toBe(true);
  });

  it('shows the pieces each side took, and +N only for the side ahead', async () => {
    // Black has taken a knight and a pawn; white has taken the queen.
    const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKB1R w KQkq - 0 5';
    const r = mountGame(gameDto({ fen, plyCount: 8, version: 8 }));
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
    const r = mountGame(
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
    const r = mountGame(
      gameDto({ black: bot, engineLevel: 'club', timePerMove: null, deadlineAt: null }),
    );
    const bar = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(bar.querySelector('img.avatar.bot')).not.toBeNull();
    expect(bar.querySelector('.rating')?.textContent).toBe('Club');
  });
});
