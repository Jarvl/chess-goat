import { encodePremoveTree } from '@group-chess/shared';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEventSource } from './support/fakeEventSource';
import type { FakeResponse } from './support/fakeFetch';
import { afterPlies, gameDto, pair, treeText } from './support/gameFixtures';
import {
  BEFORE_BC4,
  cleanupGameScreen,
  dropAll,
  GAME,
  gameRoutes,
  hashOf,
  hint,
  ITALIAN,
  mountGame,
  movePostsOf,
  pill,
  placement,
  played,
  premovePath,
  putsOf,
  resetGameScreen,
  slider,
  staleState,
  toastText,
  tokens,
  TWO_KNIGHTS,
  useConfirmations,
} from './support/gameScreen';

import { type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual =
    await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});
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

beforeEach(() => {
  adapter = resetGameScreen();
  limits.maxChars = 60_000;
});
afterEach(cleanupGameScreen);

describe('Game premoves with move confirmations on', () => {
  beforeEach(() => {
    useConfirmations('people');
  });

  it('builds premoves on the waiting move and sends them with it in one request', async () => {
    const initial = played([]);
    const r = mountGame(initial, {
      route: gameRoutes(initial, { move: () => ({ status: 200, body: played(['e2e4']) }) }),
    });
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
    const r = mountGame(played(['e2e4', 'e7e5']));
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
    expect(window.__tg!.mainButton.visible).toBe(false);
    await r.click('.lines-panel [data-path=""]');
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
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
    const r = mountGame(played(['e2e4']));
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    window.__tg!.clickSecondary();
    await r.flush();
    expect(tokens(r)).toEqual([]);
    expect(r.calls).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(placement()).toBe(played(['e2e4']).fen.split(' ')[0]);
  });

  it('labels the in-page buttons as Telegram’s below 7.10', async () => {
    const r = mountGame(played(['e2e4']), { route: gameRoutes(played(['e2e4'])), version: '7.0' });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(window.__tg!.mainButton.text).toBe('Confirm premoves');
    expect(r.root.querySelector('.toolbar [data-action="cancel-move"]')?.textContent).toBe(
      'Cancel',
    );
  });

  it('asks before replacing a reply, previews it, and Cancel puts everything back', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mountGame(initial);
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
    const r = mountGame(played(BEFORE_BC4));
    await dropAll(r, [
      ['f1', 'c4'],
      ['g8', 'f6'],
      ['f3', 'g5'],
    ]);
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
    const r = mountGame(played(BEFORE_BC4));
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
    const r = mountGame(played(BEFORE_BC4));
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
    const r = mountGame(played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) }));
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
    const r = mountGame(played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) }));
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
    const r = mountGame(played(['e2e4']));
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    FakeEventSource.instances[0]!.send('state', played(['e2e4', 'c7c5']), '2');
    await r.flush();
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.root.querySelector('.move-list [data-waiting]')).toBeNull();
  });

  it('says nothing when the opponent moves and there is no draft', async () => {
    const r = mountGame(played(['e2e4']));
    FakeEventSource.instances.at(-1)!.send('state', played(['e2e4', 'c7c5']), '2');
    await r.flush();
    expect(toastText()).toBeUndefined();
  });

  it('keeps the waiting move and the draft when Telegram minimises the app', async () => {
    const r = mountGame(played([]));
    await dropAll(r, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
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
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT') return staleState('changed');
        if (call.method === 'GET')
          return {
            status: 200,
            body: played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) }),
          };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('says the draft went when the opponent moved while Confirm premoves was on its way', async () => {
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT') return staleState();
        if (call.method === 'GET') return { status: 200, body: played(['e2e4', 'c7c5']) };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('says nothing about the draft when the game ended while Confirm premoves was on its way', async () => {
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT') return staleState('the game is over');
        if (call.method === 'GET')
          return {
            status: 200,
            body: played(['e2e4'], { status: 'finished', result: '1-0', endReason: 'resignation' }),
          };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    window.__tg!.clickMain();
    await r.flush();
    expect(toastText()).toBeUndefined();
  });

  it('keeps an oversize draft on screen and sends nothing', async () => {
    limits.maxChars = 4;
    const r = mountGame(played([]));
    await dropAll(r, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    expect(window.__tg!.mainButton.text).toBe('Confirm move + 1 premove');
  });

  it('offers no ✕ and removes nothing while a confirmed move retries', async () => {
    vi.useFakeTimers();
    const initial = played([]);
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        move: () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    });
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
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        premovePut: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).toBeNull();
    expect(r.root.querySelector('.move-list [data-action="premove-remove"]')).toBeNull();
    answer({ status: 200, body: { ...initial, premoveTree: treeText(pair('e7e5', 'g1f3')) } });
    await r.flush();
    expect(r.root.querySelector('.lines-panel [data-action="premove-remove"]')).not.toBeNull();
  });

  it('puts a move refused with 413 back to waiting, with its draft and without reloading', async () => {
    const initial = played([]);
    const r = mountGame(initial, {
      route: gameRoutes(initial, { move: () => ({ status: 413, body: undefined }) }),
    });
    await dropAll(r, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
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
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        premovePut: () => new Promise<FakeResponse>((resolve) => answers.push(resolve)),
      }),
    });
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
    await dropAll(r, [
      ['d7', 'd5'],
      ['e4', 'd5'],
    ]);
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
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT' && call.path === premovePath)
          return new Promise<FakeResponse>((resolve) => answers.push(resolve));
        if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves`)
          return { status: 200, body: after };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(putsOf(r)).toHaveLength(1);
    // Dana answers 1…c5 while that save runs, and the player replies 2.Nf3 …
    FakeEventSource.instances[0]!.send('state', played(['e2e4', 'c7c5']), '2');
    await r.flush();
    adapter.drop('g1', 'f3');
    await r.flush();
    // … then builds a premove on the new position.
    await dropAll(r, [
      ['d7', 'd6'],
      ['d2', 'd4'],
    ]);
    expect(putsOf(r)).toHaveLength(1);
    answers[0]!(staleState());
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
    const r = mountGame(initial, {
      route: gameRoutes(initial, {
        premovePut: () => new Promise<FakeResponse>((resolve) => answers.push(resolve)),
      }),
    });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
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
    await dropAll(r, [
      ['d7', 'd5'],
      ['e4', 'd5'],
    ]);
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
    const r = mountGame(initial, {
      route: (call) => {
        if (call.method === 'PUT') return staleState('changed');
        if (call.method === 'GET') return { status: 200, body: theirs };
        return gameRoutes(initial)(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(putsOf(r)).toHaveLength(0); // too big: kept on screen, unsaved
    FakeEventSource.instances[0]!.send('state', theirs, '1');
    await r.flush();
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
    limits.maxChars = 60_000;
    await r.click('.lines-panel [data-path=""]');
    await dropAll(r, [
      ['c7', 'c5'],
      ['g1', 'f3'],
    ]);
    // The change was made on the empty tree, so that is what the save names as its base.
    expect(putsOf(r)[0]?.body).toMatchObject({ baseHash: await hashOf([]), expectedPly: 1 });
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
  });

  it('keeps an unanswered opponent move on the device through a save', async () => {
    const initial = played(['e2e4']);
    const r = mountGame(initial, { route: gameRoutes(initial) });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
      ['b8', 'c6'],
    ]);
    expect(putsOf(r)).toHaveLength(1);
    expect(tokens(r)).toEqual(['e5', 'Nf3', 'Nc6']);
    expect(hint(r)).toBe('Your reply to 2…Nc6');
  });

  it('saves a confirmed replacement and a confirmed removal', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mountGame(initial, { route: gameRoutes(initial) });
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
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT') return staleState('the premoves have changed');
        if (call.method === 'GET')
          return {
            status: 200,
            body: played(['e2e4'], { premoveTree: treeText(pair('d7d5', 'e4d5')) }),
          };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(toastText()).toBe('Premoves changed on another device');
    expect(tokens(r)).toEqual(['d5', 'exd5']);
  });

  it('says the change went, not another device, when the opponent moved first', async () => {
    const r = mountGame(played(['e2e4']), {
      route: (call) => {
        if (call.method === 'PUT') return staleState();
        if (call.method === 'GET') return { status: 200, body: played(['e2e4', 'e7e5']) };
        return gameRoutes(played(['e2e4']))(call);
      },
    });
    await r.flush();
    await dropAll(r, [
      ['c7', 'c5'],
      ['g1', 'f3'],
    ]);
    expect(toastText()).toBe('Dana moved. Your unconfirmed premoves were discarded.');
    expect(tokens(r)).toEqual([]);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
  });

  it('puts the tree back and says offline when a removal fails on the network', async () => {
    const initial = played(ITALIAN, { premoveTree: treeText(TWO_KNIGHTS()) });
    const r = mountGame(initial, {
      route: (call) => {
        if (call.method === 'PUT') throw new TypeError('Failed to fetch');
        return gameRoutes(initial)(call);
      },
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
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
    const r = mountGame(initial, { route: gameRoutes(initial) });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(r.calls).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
  });

  it('treats a 413 from the server like an oversize tree, without reloading', async () => {
    const initial = played(['e2e4']);
    const r = mountGame(initial, {
      route: gameRoutes(initial, { premovePut: () => ({ status: 413, body: undefined }) }),
    });
    await dropAll(r, [
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(putsOf(r)).toHaveLength(1);
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(toastText()).toBe('This premove tree is too big to save. Remove some lines first.');
    expect(tokens(r)).toEqual(['e5', 'Nf3']);
  });

  it('offers no premoves while the player’s own move is still sending', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mountGame(played([]), {
      route: gameRoutes(played([]), {
        move: () => new Promise<FakeResponse>((resolve) => (answer = resolve)),
      }),
    });
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
    useConfirmations('people');
    const own = mountGame(played(BEFORE_BC4));
    expect([pill(own), hint(own)]).toEqual(['Your move', 'Play your move']);

    const waiting = mountGame(played(['e2e4']));
    expect([pill(waiting), hint(waiting)]).toEqual(['Dana to move', 'Play a move Dana might make']);

    const drafting = mountGame(played(ITALIAN));
    adapter.drop('g8', 'f6');
    await drafting.flush();
    expect([pill(drafting), hint(drafting)]).toEqual(['Draft', 'Your reply to 3…Nf6']);

    const saved = mountGame(
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

    const one = mountGame(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    expect(pill(one)).toBe('1 premove saved');
  });

  it('roots the Lines panel at the waiting move', async () => {
    useConfirmations('people');
    const r = mountGame(played(BEFORE_BC4));
    expect(r.root.querySelector('.lines-panel')).toBeNull();
    adapter.drop('f1', 'c4');
    await r.flush();
    expect(r.root.querySelector('.lines-root')?.textContent).toBe('3.Bc4your move');
  });

  it('roots the Lines panel at Now on the opponent’s turn', async () => {
    useConfirmations('people');
    const r = mountGame(played(['e2e4']));
    expect(r.root.querySelector('.lines-root')?.textContent).toBe('Nowcurrent position');
  });

  it('tells the player to move first when they touch the opponent’s pieces', async () => {
    const r = mountGame(played([]));
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
    const r = mountGame(played(['e2e4', 'd7d5']));
    // Chessground reports both taps of a click-click move before the move itself.
    adapter.select('e4');
    adapter.select('d5');
    adapter.drop('e4', 'd5', true);
    await r.flush();
    expect(toastText()).toBeUndefined();
    expect(movePostsOf(r)[0]?.body).toMatchObject({ uci: 'e4d5' });
  });

  it('still nudges when the selected piece cannot take the tapped one', async () => {
    const r = mountGame(played(['e2e4', 'd7d5']));
    adapter.select('g1');
    adapter.select('d5');
    await r.flush();
    expect(toastText()).toBe(
      'Play your own move first. Then you can play the moves Dana might make.',
    );
  });

  it('fills the slider green up to the real position and blue on through the shown premove', async () => {
    const r = mountGame(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
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
    const r = mountGame(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
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
    const r = mountGame(played(ITALIAN));
    FakeEventSource.instances[0]!.send(
      'state',
      played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }),
      '5',
    );
    await r.flush();
    expect(tokens(r)).toEqual(['Nf6', 'Ng5']);
  });

  it('shares the real position, never a premove one', async () => {
    const r = mountGame(played(ITALIAN, { premoveTree: treeText(pair('g8f6', 'f3g5')) }));
    await r.click('[data-action="share"]');
    await r.click('.lines-panel [data-path="g8f6,f3g5"]');
    await r.click('[data-action="share"]');
    const shares = r.calls.filter((c) => c.path === `/api/games/${GAME}/share`);
    expect(shares.map((c) => c.body)).toEqual([{ ply: 5 }, { ply: 5 }]);
  });

  it('toasts and buzzes when the tree was cancelled, and buzzes lightly when a premove played', async () => {
    const withTree = (premoveTree: string) => afterPlies(1, { viewerRole: 'white', premoveTree });
    const r = mountGame(withTree(treeText(pair('e7e5', 'g2g4'))));
    FakeEventSource.instances[0]!.send('state', afterPlies(3, { viewerRole: 'white' }), '3');
    await r.flush();
    expect(window.__tg!.haptics).toContain('impact:light');
    expect(document.querySelector('.toast')).toBeNull();

    const again = mountGame(withTree(treeText(pair('d7d5', 'e2e4'))));
    FakeEventSource.instances.at(-1)!.send('state', afterPlies(2, { viewerRole: 'white' }), '2');
    await again.flush();
    expect(document.querySelector('.toast')?.textContent).toContain('Premoves cancelled');
    expect(window.__tg!.haptics).toContain('notification:warning');
  });
});

// Leaving with an unconfirmed draft (Move confirmations spec, Sending it).

describe('Game premove replay slider', () => {
  // After 1.f3 (Black to move), White premoves: e5 -> Nh3 { d5 -> Ng5 | Nc6 -> Nc3 }.
  const TREE = treeText(
    pair('e7e5', 'g1h3', pair('d7d5', 'h3g5'), pair('b8c6', 'b1c3')),
    pair('d7d6', 'e2e4'),
  );

  it('runs from the start through the real plies to the end of the premove line', async () => {
    const r = mountGame(afterPlies(1, { viewerRole: 'white', premoveTree: TREE }));
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
});
