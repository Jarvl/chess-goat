import {
  applyMove,
  encodePremoveBytes,
  INITIAL_FEN,
  premoveTreeHash,
  type DraftNode,
  type GameDto,
  type MoveConfirmations,
  type MoveDto,
} from '@chess-goat/shared';
import { vi } from 'vitest';
import { prefs } from '../../src/state/session';
import type { Tg } from '../../src/tg/webapp';
import { Game } from '../../src/ui/screens/Game';
import { FakeEventSource } from './fakeEventSource';
import type { FakeResponse, FakeRoute } from './fakeFetch';
import { afterPlies, gameDto, pair } from './gameFixtures';
import { renderApp, type Rendered } from './render';
import { stubAdapter, type StubAdapter } from './stubAdapter';

/**
 * The game screen's test harness. A test file mocks the board adapter itself (`vi.mock` is hoisted
 * only from the test file), returning the adapter `resetGameScreen` hands it:
 *
 *   let adapter: StubAdapter;
 *   vi.mock('../src/board/adapter', …createBoardAdapter: () => adapter…);
 *   beforeEach(() => (adapter = resetGameScreen()));
 *   afterEach(cleanupGameScreen);
 */
export const GAME = 'AbCdEfGhIj';
export const premovePath = `/api/games/${GAME}/premoves`;
const movesPath = `/api/games/${GAME}/moves`;
/** The switcher strip's list of the viewer's games, which every game screen loads. */
export const meGamesPath = '/api/me/games';

const screen: { adapter: StubAdapter; confirmations: MoveConfirmations } = {
  adapter: stubAdapter(),
  confirmations: 'never',
};

/**
 * A fresh board adapter and stream, and move confirmations back to 'never': most of the screen's
 * flows predate confirmations. A describe that needs them calls `useConfirmations` in its own
 * `beforeEach`.
 */
export function resetGameScreen(): StubAdapter {
  screen.adapter = stubAdapter();
  screen.confirmations = 'never';
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  return screen.adapter;
}

/** The move confirmations setting every `mountGame` of the current test starts with. */
export function useConfirmations(setting: MoveConfirmations): void {
  screen.confirmations = setting;
}

export async function cleanupGameScreen(): Promise<void> {
  // Preact flushes effects on animation frames; run the faked ones before real timers return,
  // otherwise its effect queue stays scheduled forever and later tests never run their effects.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

/** The 409 a refused move or premove save answers with. */
export function staleState(message = 'the position has changed'): FakeResponse {
  return { status: 409, body: { error: { code: 'stale_state', message } } };
}

/**
 * The server for a game screen showing `initial`. A move POST answers the game after one ply, a
 * premove PUT the game with the tree it saved, and the switcher strip's list no other games; `on`
 * overrides any of them, or the draw buttons. Any other request answers 404, so a test that forgets
 * a route fails rather than reading `{}` as a game.
 */
export function gameRoutes(
  initial: GameDto,
  on: { move?: FakeRoute; premovePut?: FakeRoute; draw?: FakeRoute; meGames?: FakeRoute } = {},
): FakeRoute {
  return (call) => {
    if (call.method === 'GET' && call.path === meGamesPath)
      return on.meGames ? on.meGames(call) : { status: 200, body: { items: [] } };
    if (call.method === 'POST' && call.path === movesPath)
      return on.move ? on.move(call) : { status: 200, body: afterPlies(1) };
    if (call.method === 'PUT' && call.path === premovePath)
      return on.premovePut
        ? on.premovePut(call)
        : { status: 200, body: { ...initial, premoveTree: (call.body as { tree: string }).tree } };
    if (call.method === 'GET' && call.path === `/api/games/${GAME}`)
      return { status: 200, body: initial };
    if (call.method === 'POST' && /\/draw\/\w+$/.test(call.path) && on.draw) return on.draw(call);
    if (call.method === 'POST' && /\/(draw\/\w+|resign|abort)$/.test(call.path))
      return { status: 200, body: initial };
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/pgn-link`)
      return { status: 200, body: { url: `/api/games/${GAME}/pgn?token=scoped-link` } };
    if (call.method === 'POST' && /^\/api\/(telemetry|games\/\w+\/share)$/.test(call.path))
      return { status: 200, body: { ok: true } };
    return { status: 404, body: { error: { code: 'not_found', message: call.path } } };
  };
}

/**
 * Mounts the game screen on `initial`, prefetched, as the router would after a game link. Its
 * `calls` leaves out the switcher strip's list, which every game screen loads, so a count of the
 * screen's own requests keeps its meaning; `allCalls` has everything.
 */
export function mountGame(
  initial: GameDto,
  opts: {
    route?: FakeRoute;
    version?: string;
    tg?: Tg;
    confirmations?: MoveConfirmations;
    hop?: boolean;
  } = {},
): Rendered & { allCalls: Rendered['calls'] } {
  const r = renderApp(
    (app) => {
      app.prefetched.game = initial;
      return <Game gameId={GAME} hop={opts.hop} />;
    },
    opts.route ?? gameRoutes(initial),
    { version: opts.version ?? '8.0', ...(opts.tg ? { tg: opts.tg } : {}) },
  );
  // renderApp resets the preferences; the screen reads them when a move is dropped.
  prefs.value = { ...prefs.value, moveConfirmations: opts.confirmations ?? screen.confirmations };
  const allCalls = r.calls;
  return Object.defineProperty({ ...r, allCalls }, 'calls', {
    get: () => allCalls.filter((call) => call.path !== meGamesPath),
  }) as Rendered & { allCalls: Rendered['calls'] };
}

/** Drops each move on the board in turn, letting the screen settle after each. */
export async function dropAll(r: Rendered, moves: readonly [string, string][]): Promise<void> {
  for (const [orig, dest] of moves) {
    screen.adapter.drop(orig as never, dest as never);
    await r.flush();
  }
}

// Conditional premoves (spec, Behaviour and The game screen). Dana plays Black against the viewer.
export const DANA = { ...gameDto().black, name: 'Dana' };

/** A game after `ucis`, with consistent moves, fen, plyCount and version; Black is Dana. */
export function played(ucis: string[], overrides: Partial<GameDto> = {}): GameDto {
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
export const BEFORE_BC4 = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
/** …3.Bc4: Dana is to move. */
export const ITALIAN = [...BEFORE_BC4, 'f1c4'];
/** 3…Nf6 4.Ng5 d5 5.exd5. */
export const TWO_KNIGHTS = () => pair('g8f6', 'f3g5', pair('d7d5', 'e4d5'));

export const putsOf = (r: Rendered) =>
  r.calls.filter((c) => c.method === 'PUT' && c.path === premovePath);
export const movePostsOf = (r: Rendered) =>
  r.calls.filter((c) => c.method === 'POST' && c.path === movesPath);
export const hashOf = (tree: DraftNode[]) => premoveTreeHash(encodePremoveBytes(tree));
export const tokens = (r: Rendered) =>
  [...r.root.querySelectorAll('.lines-panel .lines-token')].map((b) => b.textContent);
export const pill = (r: Rendered) =>
  r.root.querySelector('.premove-status .premove-pill')?.textContent;
export const hint = (r: Rendered) =>
  r.root.querySelector('.premove-status .premove-hint')?.textContent;
export const placement = () => screen.adapter.positions.at(-1)?.fen.split(' ')[0];
export const toastText = () => document.querySelector('.toast')?.textContent;
export const slider = (r: Rendered) =>
  r.root.querySelector<HTMLInputElement>('.replay-controls input[type="range"]')!;
