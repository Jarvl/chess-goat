import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arrangeStrip,
  loadStripMinimized,
  resetStrip,
  stripGames,
  type StripGame,
} from '../src/state/switcher';
import { gameSummary } from './support/summaryFixtures';

const game = (id: string, yourTurn = true): StripGame => ({
  ...gameSummary({ id, yourTurn }),
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
});
const ids = (games: StripGame[]) => games.map((g) => g.id);

const A = game('GameAaaaaa');
const B = game('GameBbbbbb');
const C = game('GameCccccc');
const D = game('GameDddddd');

beforeEach(resetStrip);

describe('arrangeStrip', () => {
  it("keeps the server's order on arrival", () => {
    expect(ids(arrangeStrip(null, [A, B, C], A.id))).toEqual([A.id, B.id, C.id]);
  });

  it('never re-sorts what it already shows', () => {
    const moved = game(A.id, false);
    const next = arrangeStrip([A, B, C], [B, C, moved], A.id);
    expect(ids(next)).toEqual([A.id, B.id, C.id]);
    expect(next[0]!.yourTurn).toBe(false);
  });

  it('appends a game that newly appears', () => {
    expect(ids(arrangeStrip([A, B], [D, A, B], A.id))).toEqual([A.id, B.id, D.id]);
  });

  it("drops a game that ended, but not the one you're on", () => {
    expect(ids(arrangeStrip([A, B, C], [C], A.id))).toEqual([A.id, C.id]);
  });

  it('leaves out a current game the list does not have, on arrival', () => {
    expect(ids(arrangeStrip(null, [B, C], A.id))).toEqual([B.id, C.id]);
  });
});

describe('resetStrip', () => {
  it('forgets the order', () => {
    stripGames.value = [A, B];
    resetStrip();
    expect(stripGames.value).toBeNull();
  });
});

describe('loadStripMinimized', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads the choice remembered on this device', () => {
    expect(loadStripMinimized()).toBe(false);
    localStorage.setItem('switcher.minimized', '1');
    expect(loadStripMinimized()).toBe(true);
  });

  it('opens the strip when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadStripMinimized()).toBe(false);
  });
});
