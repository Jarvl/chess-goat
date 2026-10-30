import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameStore } from '../src/state/game';
import { MoveList } from '../src/ui/game/MoveList';
import { Game } from '../src/ui/screens/Game';
import { FakeEventSource } from './support/fakeEventSource';
import type { FakeRoute } from './support/fakeFetch';
import { afterPlies, pair, treeText } from './support/gameFixtures';
import { renderApp } from './support/render';
import { stubAdapter, type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

beforeEach(() => {
  adapter = stubAdapter();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const ok = () => ({ status: 200, body: { ok: true } });

// After 1.f3 (Black to move), White premoves: e5 -> Nh3 { d5 -> Ng5 | Nc6 -> Nc3 }.
const TREE = treeText(
  pair('e7e5', 'g1h3', pair('d7d5', 'h3g5'), pair('b8c6', 'b1c3')),
  pair('d7d6', 'e2e4'),
);
const opponentsTurn = () =>
  new GameStore(afterPlies(1, { viewerRole: 'white', premoveTree: TREE }));

// After 1.f3 e5 (White to move): the move Nh3 waits for Confirm, then Black's d5 is answered Ng5.
const WAITING_TREE = treeText(pair('d7d5', 'h3g5', pair('f8c5', 'b1c3')), pair('b8c6', 'b1c3'));
function withWaiting(): GameStore {
  const store = new GameStore(afterPlies(2, { viewerRole: 'white', premoveTree: WAITING_TREE }));
  store.waiting.value = { uci: 'g1h3', san: 'Nh3' };
  return store;
}

const strip = (r: { root: HTMLElement }) => r.root.querySelector('.move-list')!;
const current = (r: { root: HTMLElement }) =>
  r.root.querySelector('.move-list button[aria-current="true"]');

describe('MoveList strip', () => {
  it('shows the real moves, then the premove line: opponent moves plain, replies as chips', async () => {
    const store = opponentsTurn();
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    expect(strip(r).textContent).toBe('1.f3e52.Nh3d53.Ng5');
    expect(strip(r).querySelectorAll('[data-ply]')).toHaveLength(1);
    expect(strip(r).querySelector('[data-waiting]')).toBeNull();
    const line = [...strip(r).querySelectorAll('[data-line]')];
    expect(line.map((b) => b.getAttribute('data-line'))).toEqual(['0', '1', '2', '3']);
    expect(line.map((b) => b.textContent)).toEqual(['e5', 'Nh3', 'd5', 'Ng5']);
    expect(line.map((b) => b.classList.contains('line-opponent'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(line.map((b) => b.classList.contains('premove-chip'))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(strip(r).querySelectorAll('.premove-number')).toHaveLength(2);
    // Nothing is selected yet: the last real move is the current one.
    expect(current(r)?.getAttribute('data-ply')).toBe('1');
  });

  it('puts the waiting move between the real moves and the line, outlined', async () => {
    const store = withWaiting();
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    expect(strip(r).textContent).toBe('1.f3e52.Nh3d53.Ng5Bc54.Nc3');
    const waiting = strip(r).querySelector('[data-waiting]')!;
    expect(waiting.textContent).toBe('Nh3');
    expect(waiting.classList.contains('waiting')).toBe(true);
    expect(waiting.previousElementSibling?.classList.contains('number')).toBe(true);
    expect(waiting.getAttribute('aria-current')).toBe('true');
    expect(current(r)).toBe(waiting);
    // Order: real, waiting, line.
    const order = [...strip(r).querySelectorAll('button')].map(
      (b) => b.getAttribute('data-ply') ?? (b.hasAttribute('data-waiting') ? 'w' : b.dataset.line),
    );
    expect(order).toEqual(['1', '2', 'w', '0', '1', '2', '3']);
  });

  it('tapping a line move selects it: aria-current and the store follow', async () => {
    const store = opponentsTurn();
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    await r.click('[data-line="2"]');
    expect(store.selected.value).toEqual(['e7e5', 'g1h3', 'd7d5']);
    expect(store.timeline.value.at).toBe(4);
    expect(current(r)?.getAttribute('data-line')).toBe('2');
    expect(current(r)?.classList.contains('line-opponent')).toBe(true);
    expect(window.__tg!.haptics).toContain('selection');
    await r.click('[data-line="1"]');
    expect(current(r)?.getAttribute('data-line')).toBe('1');
    // The line keeps its branch while it is walked back.
    expect(strip(r).querySelector('[data-line="3"]')?.textContent).toBe('Ng5');
  });

  it('tapping the waiting move and the real moves moves the timeline', async () => {
    const store = withWaiting();
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    await r.click('[data-line="1"]');
    expect(current(r)?.getAttribute('data-line')).toBe('1');
    await r.click('[data-waiting]');
    expect(store.selected.value).toEqual([]);
    expect(current(r)?.hasAttribute('data-waiting')).toBe(true);
    // The real move before the waiting one is the position before it.
    await r.click('[data-ply="2"]');
    expect(store.viewingPly.value).toBe(2);
    expect(current(r)?.getAttribute('data-ply')).toBe('2');
    expect(strip(r).querySelector('[data-line]')).not.toBeNull();
    await r.click('[data-ply="1"]');
    expect(store.viewingPly.value).toBe(1);
  });

  it('still says there are no moves when there is nothing at all', async () => {
    const store = new GameStore(afterPlies(0, { viewerRole: 'spectator' }));
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    expect(r.text()).toContain('No moves yet');
  });

  it('shows a line before any real move', async () => {
    const store = new GameStore(
      afterPlies(0, { viewerRole: 'black', premoveTree: treeText(pair('e2e4', 'e7e5')) }),
    );
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    expect(strip(r).textContent).toBe('1.e4e5');
    expect(r.text()).not.toContain('No moves yet');
  });
});

describe('MoveList remove button', () => {
  it('follows the current line move only, and calls onRemove', async () => {
    const store = opponentsTurn();
    const removed: number[] = [];
    const r = renderApp(() => <MoveList store={store} onRemove={() => removed.push(1)} />, ok);
    await r.flush();
    const buttons = () => r.root.querySelectorAll('[data-action="premove-remove"]');
    // Resting on the real position: nothing selected, no ✕.
    expect(buttons()).toHaveLength(0);
    await r.click('[data-line="1"]');
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]?.previousElementSibling?.getAttribute('data-line')).toBe('1');
    await r.click('[data-line="2"]');
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]?.previousElementSibling?.getAttribute('data-line')).toBe('2');
    await r.click('[data-action="premove-remove"]');
    expect(removed).toEqual([1]);
  });

  it('is never on a real move or the waiting move, nor while an earlier move is shown', async () => {
    const store = withWaiting();
    const r = renderApp(() => <MoveList store={store} onRemove={() => {}} />, ok);
    await r.flush();
    const buttons = () => r.root.querySelectorAll('[data-action="premove-remove"]');
    expect(buttons()).toHaveLength(0); // the waiting move is current
    await r.click('[data-line="0"]');
    expect(buttons()).toHaveLength(1);
    await r.click('[data-waiting]');
    expect(buttons()).toHaveLength(0);
    await r.click('[data-line="3"]');
    expect(buttons()).toHaveLength(1);
    await r.click('[data-ply="2"]');
    expect(buttons()).toHaveLength(0);
    await r.click('[data-ply="1"]');
    expect(buttons()).toHaveLength(0);
  });

  it('is not offered without an onRemove handler', async () => {
    const store = opponentsTurn();
    const r = renderApp(() => <MoveList store={store} />, ok);
    await r.flush();
    await r.click('[data-line="1"]');
    expect(r.root.querySelector('[data-action="premove-remove"]')).toBeNull();
  });
});

describe('MoveList scrolling', () => {
  // happy-dom does no layout, so the strip is 200px wide with every child 60px wide, in order.
  const WIDTH = 60;
  const VIEW = 200;
  beforeEach(() => {
    const children = (element: HTMLElement) => [...(element.parentElement?.children ?? [])];
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return children(this).indexOf(this) * WIDTH;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(WIDTH);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(VIEW);
  });
  afterEach(() => vi.restoreAllMocks());

  it('scrolls so the selected line move and its ✕ are in view', async () => {
    const store = opponentsTurn();
    const r = renderApp(() => <MoveList store={store} onRemove={() => {}} />, ok);
    await r.flush();
    await r.click('[data-line="3"]');
    await r.flush();
    const element = strip(r) as HTMLElement;
    const remove = element.querySelector('[data-action="premove-remove"]') as HTMLElement;
    expect(remove).not.toBeNull();
    const right = remove.offsetLeft + remove.offsetWidth;
    expect(element.scrollLeft).toBe(right - VIEW);
    expect(element.scrollLeft).toBeLessThanOrEqual((current(r) as HTMLElement).offsetLeft);
  });

  it('scrolls back to an earlier move that is out of view', async () => {
    const store = opponentsTurn();
    const r = renderApp(() => <MoveList store={store} onRemove={() => {}} />, ok);
    await r.flush();
    await r.click('[data-line="3"]');
    await r.flush();
    await r.click('[data-ply="1"]');
    await r.flush();
    const element = strip(r) as HTMLElement;
    expect(element.scrollLeft).toBeLessThanOrEqual((current(r) as HTMLElement).offsetLeft);
  });
});

describe('Replay slider', () => {
  const GAME = 'AbCdEfGhIj';
  function mount(dto: ReturnType<typeof afterPlies>) {
    const route: FakeRoute = (call) =>
      call.method === 'GET' && call.path === `/api/games/${GAME}`
        ? { status: 200, body: dto }
        : { status: 200, body: { ok: true } };
    return renderApp((app) => {
      app.prefetched.game = dto;
      return <Game gameId={GAME} />;
    }, route);
  }
  const slider = (r: { root: HTMLElement }) =>
    r.root.querySelector<HTMLInputElement>('.replay-controls input[type="range"]')!;

  it('runs from the start through the real plies to the end of the premove line', async () => {
    const r = mount(afterPlies(1, { viewerRole: 'white', premoveTree: TREE }));
    await r.flush();
    expect(slider(r).max).toBe('5');
    expect(slider(r).value).toBe('1');
    expect(slider(r).classList.contains('premove')).toBe(false);
    await r.click('[data-action="next"]');
    expect(slider(r).value).toBe('2');
    expect(slider(r).classList.contains('premove')).toBe(true);
    expect(slider(r).style.getPropertyValue('--real')).toBe('20%');
    expect(slider(r).style.getPropertyValue('--at')).toBe('40%');
    await r.click('[data-action="next"]');
    await r.click('[data-action="next"]');
    await r.click('[data-action="next"]');
    expect(slider(r).value).toBe('5');
    expect(r.root.querySelector('[data-line="3"]')?.getAttribute('aria-current')).toBe('true');
    // ◀ steps back along the line, then into the game's history.
    await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('4');
    for (let i = 0; i < 3; i += 1) await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('1');
    expect(slider(r).classList.contains('premove')).toBe(false);
    await r.click('[data-action="prev"]');
    expect(slider(r).value).toBe('0');
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="prev"]')?.disabled).toBe(false);
  });

  it('dragging the slider onto the line selects that move in the strip', async () => {
    const r = mount(afterPlies(1, { viewerRole: 'white', premoveTree: TREE }));
    await r.flush();
    const input = slider(r);
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(
      r.root.querySelector('.move-list [aria-current="true"]')?.getAttribute('data-line'),
    ).toBe('1');
  });

  it('is disabled when the game has no moves and no line', async () => {
    const r = mount(afterPlies(0, { viewerRole: 'spectator' }));
    await r.flush();
    expect(slider(r).disabled).toBe(true);
  });
});
