import { describe, expect, it } from 'vitest';
import { backfillDedupKey, canRunBackfill } from '../../src/flair/backfill';
import { isCountedGame } from '../../src/flair/history';

describe('backfillDedupKey', () => {
  it('names the pairs sorted by id', () => {
    expect(
      backfillDedupKey([
        { id: 'rank_1200', version: 1 },
        { id: 'draws_10', version: 2 },
      ]),
    ).toBe('flair:backfill:draws_10@2,rank_1200@1');
  });
});

describe('canRunBackfill', () => {
  it('runs only pairs this build knows, at a version it has reached', () => {
    expect(canRunBackfill([{ id: 'draws_10', version: 1 }])).toBe(true);
    expect(canRunBackfill([{ id: 'retired_flair', version: 1 }])).toBe(false);
    expect(canRunBackfill([{ id: 'draws_10', version: 2 }])).toBe(false);
  });
});

describe('isCountedGame', () => {
  const decided = { status: 'finished', voidedAt: null, result: '1-0', engineLevel: null } as const;
  it('counts a finished, decided game against a person', () => {
    expect(isCountedGame(decided)).toBe(true);
    expect(isCountedGame({ ...decided, result: '1/2-1/2' })).toBe(true);
  });
  it('leaves out aborts, voids, bot games and running games', () => {
    expect(isCountedGame({ ...decided, result: '*' })).toBe(false);
    expect(isCountedGame({ ...decided, voidedAt: new Date() })).toBe(false);
    expect(isCountedGame({ ...decided, engineLevel: 'beginner' })).toBe(false);
    expect(isCountedGame({ ...decided, status: 'active', result: null })).toBe(false);
  });
});
