import { describe, expect, it } from 'vitest';
import { sideResult } from '../src/ui/game/result';
import { afterPlies } from './support/gameFixtures';

describe('result labels', () => {
  const finished = afterPlies(4, {
    status: 'finished',
    result: '0-1',
    endReason: 'checkmate',
    viewerRole: 'black',
  });

  it('tags the winner Won with the reason, and the loser Lost with none', () => {
    expect(sideResult(finished, 'black')).toEqual({ tag: 'won', reason: 'Checkmate' });
    expect(sideResult(finished, 'white')).toEqual({ tag: 'lost', reason: null });
    // The tags name each side, so they read the same for a spectator.
    expect(sideResult({ ...finished, viewerRole: 'spectator' }, 'black')?.tag).toBe('won');
  });

  it('tags both sides Draw with the reason', () => {
    const draw = { ...finished, result: '1/2-1/2' as const, endReason: 'draw_agreement' as const };
    expect(sideResult(draw, 'white')).toEqual({ tag: 'draw', reason: 'Draw agreed' });
    expect(sideResult(draw, 'black')).toEqual({ tag: 'draw', reason: 'Draw agreed' });
  });

  it('tags both sides Aborted, with the reason under White only', () => {
    const aborted = { ...finished, result: '*' as const, endReason: 'abort' as const };
    expect(sideResult(aborted, 'white')).toEqual({ tag: 'aborted', reason: 'Aborted' });
    expect(sideResult(aborted, 'black')).toEqual({ tag: 'aborted', reason: null });
  });

  it('tags both sides Voided with no reason', () => {
    const voided = { ...finished, voided: true };
    expect(sideResult(voided, 'white')).toEqual({ tag: 'voided', reason: null });
    expect(sideResult(voided, 'black')).toEqual({ tag: 'voided', reason: null });
  });

  it('has no result while the game is on', () => {
    expect(sideResult(afterPlies(2), 'white')).toBeNull();
  });
});
