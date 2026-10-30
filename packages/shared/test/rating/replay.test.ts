import { describe, expect, it } from 'vitest';
import {
  applyRatedGame,
  replayRatings,
  scoreFor,
  type PlayerRatingState,
  type RatedGameRecord,
} from '../../src/rating/replay';

const day = 86_400_000;
const t0 = new Date('2026-09-01T12:00:00Z');
const game = (
  white: string,
  black: string,
  result: RatedGameRecord['result'],
  daysAfterT0: number,
): RatedGameRecord => ({
  white,
  black,
  result,
  finishedAt: new Date(t0.getTime() + daysAfterT0 * day),
});

describe('scoreFor', () => {
  it('maps the PGN result to each side', () => {
    expect(scoreFor('1-0', 'white')).toBe(1);
    expect(scoreFor('1-0', 'black')).toBe(0);
    expect(scoreFor('0-1', 'white')).toBe(0);
    expect(scoreFor('1/2-1/2', 'black')).toBe(0.5);
  });
});

describe('applyRatedGame', () => {
  it('rates two newcomers from the initial rating and records the result', () => {
    const states = new Map<string, PlayerRatingState>();
    const snapshot = applyRatedGame(states, game('alice', 'bob', '1-0', 0));

    expect(snapshot.white.before).toEqual({ rating: 1500, rd: 350, volatility: 0.06 });
    expect(snapshot.black.before).toEqual({ rating: 1500, rd: 350, volatility: 0.06 });
    expect(snapshot.white.after.rating).toBeGreaterThan(1500);
    expect(snapshot.black.after.rating).toBeLessThan(1500);
    expect(snapshot.white.after.rating - 1500).toBeCloseTo(1500 - snapshot.black.after.rating, 6);

    const alice = states.get('alice');
    const bob = states.get('bob');
    expect(alice).toMatchObject({ gamesPlayed: 1, wins: 1, draws: 0, losses: 0 });
    expect(bob).toMatchObject({ gamesPlayed: 1, wins: 0, draws: 0, losses: 1 });
    expect(alice?.lastRatedGameAt).toEqual(t0);
    expect(alice?.rating).toBe(snapshot.white.after.rating);
  });

  it('counts a draw for both players', () => {
    const states = new Map<string, PlayerRatingState>();
    applyRatedGame(states, game('alice', 'bob', '1/2-1/2', 0));
    expect(states.get('alice')).toMatchObject({ draws: 1, wins: 0, losses: 0 });
    expect(states.get('bob')).toMatchObject({ draws: 1, wins: 0, losses: 0 });
    expect(states.get('alice')?.rating).toBeCloseTo(1500, 6);
  });

  it('widens a returning player’s deviation before applying the result', () => {
    const states = new Map<string, PlayerRatingState>();
    const first = applyRatedGame(states, game('alice', 'bob', '1-0', 0));
    const second = applyRatedGame(states, game('bob', 'alice', '0-1', 100));
    expect(second.black.before.rd).toBeGreaterThan(first.white.after.rd);
    expect(second.black.before.rating).toBe(first.white.after.rating);
  });
});

describe('replayRatings', () => {
  const games = [
    game('alice', 'bob', '1-0', 0),
    game('bob', 'carol', '1-0', 1),
    game('carol', 'alice', '1/2-1/2', 2),
  ];

  it('produces one snapshot per game and a state per player', () => {
    const { states, snapshots } = replayRatings(games);
    expect(snapshots).toHaveLength(3);
    expect([...states.keys()].sort()).toEqual(['alice', 'bob', 'carol']);
    expect(states.get('bob')).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1 });
  });

  it('changes later snapshots when an earlier game is voided out of the replay', () => {
    const full = replayRatings(games);
    const withoutSecond = replayRatings([games[0]!, games[2]!]);
    expect(withoutSecond.snapshots[1]?.white.before.rating).not.toBeCloseTo(
      full.snapshots[2]?.white.before.rating ?? 0,
      3,
    );
    expect(withoutSecond.states.get('carol')?.gamesPlayed).toBe(1);
  });
});
