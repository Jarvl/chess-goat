import {
  opposite,
  type Colour,
  type EndReason,
  type FlairRule,
  type PlayerResult,
} from '@chess-goat/shared';
import { gaveMate, madePattern, type StoredMove } from './patterns';

/** One of a player's counted games (flair spec §1.3), reduced to the columns flair reads. */
export type CountedGame = {
  id: number;
  startedAt: Date;
  finishedAt: Date;
  rated: boolean;
  /** From this player's side. */
  result: PlayerResult;
  /** This player's rating after the game, unrounded; null when there is none. */
  ratingAfter: number | null;
  /** The side this player had in the game. */
  side: Colour;
  /** How the game ended; a counted game always has one, but a null matches no `ended` rule. */
  endReason: EndReason | null;
  /** The other side's user id: never the bot, whose games are not counted. */
  opponentId: number;
};

/**
 * What a rule is scored on: one player at one of their counted games. A rule's answer may depend
 * only on that game and the player's earlier counted games (spec §1.6), so the context carries no
 * later games and only the moves of `game`.
 */
export type RuleContext = {
  game: CountedGame;
  /** This player's counted games up to and including `game`, oldest first. */
  history: readonly CountedGame[];
  /** `game`'s stored moves, in ply order from ply 1 (see `madePattern`). */
  moves: readonly StoredMove[];
  /** The side this player had in `game`. */
  side: Colour;
};

/** The filter of `total`: with `rated`, casual games are skipped. */
function passesFilter(rule: { rated: boolean }, past: CountedGame): boolean {
  return !rule.rated || past.rated;
}

/** One evaluator per rule kind (spec §1.4); a kind without one fails the typecheck. */
const EVALUATORS: {
  [K in FlairRule['kind']]: (rule: Extract<FlairRule, { kind: K }>, ctx: RuleContext) => boolean;
} = {
  // The rating a rated game left, rounded as the API shows it (1199.5 reads 1200), is in the band;
  // a null bound is open.
  held: (rule, { game }) => {
    if (!game.rated || game.ratingAfter === null) return false;
    const shown = Math.round(game.ratingAfter);
    return (rule.min === null || shown >= rule.min) && (rule.max === null || shown <= rule.max);
  },
  made: (rule, { moves, side }) => madePattern(rule.pattern, moves, side),
  won: (rule, { game, moves, side }) =>
    game.result === 'win' && madePattern(rule.pattern, moves, side),
  // The opponent made the pattern: it was done to this player.
  lost: (rule, { game, moves, side }) =>
    game.result === 'loss' && madePattern(rule.pattern, moves, opposite(side)),
  // Timed from the game's start (the challenge's acceptance) to its end, as games have no clock.
  quickMate: (rule, { game, moves, side }) =>
    game.result === 'win' &&
    gaveMate(moves, side) &&
    game.finishedAt.getTime() - game.startedAt.getTime() <= rule.seconds * 1000,
  // The last `length` rated games, this one included, all have the result: the run is at least
  // `length` long, not exactly. An award missed at the `length`-th game is therefore made at the
  // next qualifying one. Casual games neither extend nor break the run.
  streak: (rule, { game, history }) => {
    if (!game.rated) return false;
    const run = history.filter((past) => past.rated).slice(-rule.length);
    return run.length === rule.length && run.every((past) => past.result === rule.result);
  },
  // This game has the result, and so do at least `count` games that pass the filter, this one
  // included, in a row or not.
  total: (rule, { game, history }) =>
    passesFilter(rule, game) &&
    game.result === rule.result &&
    history.filter((past) => passesFilter(rule, past) && past.result === rule.result).length >=
      rule.count,
  ended: (rule, { game }) => game.result === rule.result && game.endReason === rule.reason,
  // Games against this game's opponent, this one included, in any group and rated or casual. With
  // a result, this game must have it too, so the award comes at a game that does.
  against: (rule, { game, history }) =>
    (rule.result === null || game.result === rule.result) &&
    history.filter(
      (past) =>
        past.opponentId === game.opponentId &&
        (rule.result === null || past.result === rule.result),
    ).length >= rule.count,
};

/** Whether `rule` holds for the player at `ctx.game` (flair spec §1.4). */
export function ruleHolds(rule: FlairRule, ctx: RuleContext): boolean {
  // `rule.kind` picks the evaluator written for exactly this rule's shape, which the registry's
  // type guarantees but TypeScript cannot follow through the union (it would ask for a rule of
  // every kind at once).
  const evaluate = EVALUATORS[rule.kind] as (rule: FlairRule, ctx: RuleContext) => boolean;
  return evaluate(rule, ctx);
}
