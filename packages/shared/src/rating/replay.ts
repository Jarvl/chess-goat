import type { Colour } from '../protocol/enums';
import {
  INITIAL_RATING,
  inflateForInactivity,
  ratePeriod,
  type Rating,
  type Score,
} from './glicko2';

export type PlayerRatingState = Rating & {
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  lastRatedGameAt: Date | null;
};

export type RatedGameRecord = {
  white: string;
  black: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  finishedAt: Date;
  /**
   * The side whose rating the game must not move (a human playing a bot): its state is read as
   * the opponent rating but never written, and its snapshot has `after` equal to `before`.
   */
  frozen?: Colour;
};

export type RatingSnapshot = {
  white: { before: Rating; after: Rating };
  black: { before: Rating; after: Rating };
};

const MS_PER_DAY = 86_400_000;

export function freshPlayerState(): PlayerRatingState {
  return {
    ...INITIAL_RATING,
    gamesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    lastRatedGameAt: null,
  };
}

export function scoreFor(result: RatedGameRecord['result'], colour: Colour): Score {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (colour === 'white') ? 1 : 0;
}

/** Fractional days since the player's last rated game in this group; 0 for a first game. */
export function idleDaysBefore(state: PlayerRatingState, at: Date): number {
  if (!state.lastRatedGameAt) return 0;
  return Math.max(0, (at.getTime() - state.lastRatedGameAt.getTime()) / MS_PER_DAY);
}

function toRating(state: PlayerRatingState): Rating {
  return { rating: state.rating, rd: state.rd, volatility: state.volatility };
}

function advance(
  state: PlayerRatingState,
  after: Rating,
  score: Score,
  at: Date,
): PlayerRatingState {
  return {
    ...after,
    gamesPlayed: state.gamesPlayed + 1,
    wins: state.wins + (score === 1 ? 1 : 0),
    draws: state.draws + (score === 0.5 ? 1 : 0),
    losses: state.losses + (score === 0 ? 1 : 0),
    lastRatedGameAt: at,
  };
}

/**
 * Applies one rated result as its own rating period for both players (spec §7.5), inflating each
 * player's deviation for the days they were idle first. Mutates `states` (except a `frozen` side,
 * which is neither changed nor created); returns the snapshots the game row stores.
 */
export function applyRatedGame(
  states: Map<string, PlayerRatingState>,
  game: RatedGameRecord,
): RatingSnapshot {
  const white = states.get(game.white) ?? freshPlayerState();
  const black = states.get(game.black) ?? freshPlayerState();
  const whiteBefore = inflateForInactivity(toRating(white), idleDaysBefore(white, game.finishedAt));
  const blackBefore = inflateForInactivity(toRating(black), idleDaysBefore(black, game.finishedAt));
  const whiteScore = scoreFor(game.result, 'white');
  const blackScore = scoreFor(game.result, 'black');
  const whiteAfter =
    game.frozen === 'white'
      ? whiteBefore
      : ratePeriod(whiteBefore, [{ opponent: blackBefore, score: whiteScore }]);
  const blackAfter =
    game.frozen === 'black'
      ? blackBefore
      : ratePeriod(blackBefore, [{ opponent: whiteBefore, score: blackScore }]);
  if (game.frozen !== 'white')
    states.set(game.white, advance(white, whiteAfter, whiteScore, game.finishedAt));
  if (game.frozen !== 'black')
    states.set(game.black, advance(black, blackAfter, blackScore, game.finishedAt));
  return {
    white: { before: whiteBefore, after: whiteAfter },
    black: { before: blackBefore, after: blackAfter },
  };
}

/** Rebuilds a group's ratings from scratch; `games` must be in `finishedAt` order. */
export function replayRatings(games: readonly RatedGameRecord[]): {
  states: Map<string, PlayerRatingState>;
  snapshots: RatingSnapshot[];
} {
  const states = new Map<string, PlayerRatingState>();
  const snapshots = games.map((game) => applyRatedGame(states, game));
  return { states, snapshots };
}
