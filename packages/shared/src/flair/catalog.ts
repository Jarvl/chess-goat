/**
 * The flair catalog (flair spec §1): the emoji a player can earn and the rule that earns each one.
 * It is data only, so it adds almost nothing to the Mini App bundle.
 *
 * - A new flair built from existing rules is one entry in `FLAIR` plus one `flair.<id>` string in
 *   `i18n/en.ts`. An entry's position is its display position within its category.
 * - A new kind of condition is a move-pattern detector or a rule evaluator, with unit tests.
 * - Ids are permanent and never reused: awards and backfill versions are keyed by id.
 * - Editing a rule only affects future awards; raise `backfill` to apply a loosened rule to past
 *   games (backfill spec §1). Flair already earned is kept.
 */
import type { MessageKey } from '../i18n';
import type { EndReason } from '../protocol/enums';

/**
 * The categories, in display order: the rank ladder (ratings held), feats (things done in play, such
 * as winning with a move pattern or drawing ten games) and dubious honours (things done to you). The
 * Flair screen draws a section for each one listed here, and the type below is derived from the
 * list, so no category can exist without its section.
 */
export const FLAIR_CATEGORIES = ['rank', 'feat', 'dubious'] as const;

export type FlairCategory = (typeof FLAIR_CATEGORIES)[number];

/** Things a side can do in a game, found by the server in the game's stored moves (spec §1.8). */
export type MovePattern =
  | 'en_passant'
  | 'castle_queenside'
  | 'promotion'
  | 'underpromotion'
  | 'queen_mate'
  | 'bishops_mate'
  | 'flawless_mate'
  | 'marathon'
  | 'pacifist_mate'
  | 'bongcloud'
  | 'scholars_mate';

/** A game's result from one player's side. */
export type PlayerResult = 'win' | 'draw' | 'loss';

/**
 * What earns a flair (spec §1.4), evaluated for one player at one of their counted games:
 * - `held`: their rating after a rated game, rounded as displayed, is in `[min, max]`; a null bound
 *   is open.
 * - `made`: they made `pattern`, whatever the result.
 * - `won`: they won and made `pattern`. `lost`: they lost and their opponent made `pattern`.
 * - `quickMate`: they won by mate at most `seconds` after the game started.
 * - `ended`: their result was `result` and the game ended by `reason`.
 * - `against`: at least `count` of their games were against this game's opponent, in any group,
 *   rated or casual; with `result`, this game has it and only games with it count.
 * - `streak`: the last `length` rated games all have `result`. Every streak is rated: casual games
 *   neither extend nor break the run.
 * - `total`: at least `count` games that pass the filter have `result`.
 *
 * With `rated`, `total` skips casual games. A rule's answer at a game may depend only on that
 * game and the player's earlier counted games (§1.6), which is what lets each game be evaluated
 * once, as it ends.
 */
export type FlairRule =
  | { kind: 'held'; min: number | null; max: number | null }
  | { kind: 'made'; pattern: MovePattern }
  | { kind: 'won'; pattern: MovePattern }
  | { kind: 'lost'; pattern: MovePattern }
  | { kind: 'quickMate'; seconds: number }
  | { kind: 'ended'; result: PlayerResult; reason: EndReason }
  | { kind: 'against'; count: number; result: PlayerResult | null }
  | { kind: 'streak'; result: PlayerResult; length: number }
  | { kind: 'total'; result: PlayerResult; count: number; rated: boolean };

export type FlairDefinition = {
  /** Permanent and never reused: what the database stores. */
  id: string;
  emoji: string;
  category: FlairCategory;
  rule: FlairRule;
  /** The backfill version (backfill spec §1). Absent means 1; bump it to backfill this flair again. */
  backfill?: number;
};

/** How many flair a player wears at once. */
export const MAX_WORN_FLAIR = 3;

/** A rating band, both ends inclusive; `null` leaves that end open. */
export function held(min: number | null, max: number | null): FlairRule {
  return { kind: 'held', min, max };
}

/** Make `pattern` in a game, whatever the result. */
export function made(pattern: MovePattern): FlairRule {
  return { kind: 'made', pattern };
}

/** Win a game in which you made `pattern`. */
export function won(pattern: MovePattern): FlairRule {
  return { kind: 'won', pattern };
}

/** Lose a game in which your opponent made `pattern`. */
export function lost(pattern: MovePattern): FlairRule {
  return { kind: 'lost', pattern };
}

/** Win by mate at most `seconds` after the game started. */
export function quickMate(seconds: number): FlairRule {
  return { kind: 'quickMate', seconds };
}

/** Get `result` in a game that ended by `reason`, such as a loss by resignation. */
export function ended(result: PlayerResult, reason: EndReason): FlairRule {
  return { kind: 'ended', result, reason };
}

/** Play `count` games against one person, or with `result`, get it against them `count` times. */
export function against(count: number, result?: PlayerResult): FlairRule {
  return { kind: 'against', count, result: result ?? null };
}

/** `length` rated games in a row with `result`; casual games are skipped. */
export function streak(result: PlayerResult, length: number): FlairRule {
  return { kind: 'streak', result, length };
}

/** `count` games with `result`, in a row or not. With `rated`, casual games are skipped. */
export function total(
  result: PlayerResult,
  count: number,
  options?: { rated?: boolean },
): FlairRule {
  return { kind: 'total', result, count, rated: options?.rated ?? false };
}

/** Every flair, in display order (spec §1.2). */
export const FLAIR = [
  { id: 'rank_under_1200', emoji: '🦍', category: 'rank', rule: held(null, 1199) },
  { id: 'rank_1200', emoji: '🧑‍🦼', category: 'rank', rule: held(1200, 1299) },
  { id: 'rank_1300', emoji: '🧑‍🦽', category: 'rank', rule: held(1300, 1399) },
  { id: 'rank_1400', emoji: '🧑‍🦯', category: 'rank', rule: held(1400, 1499) },
  { id: 'rank_1500', emoji: '🚶', category: 'rank', rule: held(1500, 1599) },
  { id: 'rank_1600', emoji: '🏃', category: 'rank', rule: held(1600, 1699) },
  { id: 'rank_1700', emoji: '🗿', category: 'rank', rule: held(1700, 1799) },
  { id: 'rank_1800', emoji: '🤖', category: 'rank', rule: held(1800, null) },
  { id: 'en_passant_win', emoji: '👑', category: 'feat', rule: won('en_passant') },
  { id: 'win_streak_3', emoji: '🌡️', category: 'feat', rule: streak('win', 3) },
  { id: 'win_streak_5', emoji: '🔥', category: 'feat', rule: streak('win', 5) },
  { id: 'win_streak_10', emoji: '🌋', category: 'feat', rule: streak('win', 10) },
  { id: 'queenside_castle_win', emoji: '🏰', category: 'feat', rule: won('castle_queenside') },
  // Once a win with a promotion; loosened to any promotion, and backfilled again for it.
  { id: 'promotion_win', emoji: '♟️', category: 'feat', rule: made('promotion'), backfill: 2 },
  { id: 'underpromotion_win', emoji: '🫦', category: 'feat', rule: won('underpromotion') },
  { id: 'queen_mate', emoji: '💅', category: 'feat', rule: won('queen_mate') },
  { id: 'bishops_mate', emoji: '🗼', category: 'feat', rule: won('bishops_mate') },
  { id: 'flawless_mate', emoji: '🪬', category: 'feat', rule: won('flawless_mate') },
  { id: 'quick_mate', emoji: '🏎️', category: 'feat', rule: quickMate(180) },
  { id: 'draws_10', emoji: '🤝', category: 'feat', rule: total('draw', 10) },
  { id: 'marathon_win', emoji: '🐢', category: 'feat', rule: won('marathon') },
  { id: 'pacifist_mate', emoji: '🕊️', category: 'feat', rule: won('pacifist_mate') },
  { id: 'rival_5', emoji: '👬', category: 'feat', rule: against(5) },
  { id: 'timeout_win', emoji: '🚩', category: 'feat', rule: ended('win', 'timeout') },
  { id: 'scholars_mate_loss', emoji: '🪤', category: 'dubious', rule: lost('scholars_mate') },
  { id: 'bongcloud_win', emoji: '💨', category: 'dubious', rule: won('bongcloud') },
  { id: 'loss_streak_3', emoji: '👶', category: 'dubious', rule: streak('loss', 3) },
  { id: 'loss_streak_5', emoji: '💩', category: 'dubious', rule: streak('loss', 5) },
  { id: 'loss_streak_10', emoji: '🗑️', category: 'dubious', rule: streak('loss', 10) },
  { id: 'nemesis_5', emoji: '😈', category: 'dubious', rule: against(5, 'loss') },
  { id: 'resigned', emoji: '🐔', category: 'dubious', rule: ended('loss', 'resignation') },
  { id: 'timed_out', emoji: '💤', category: 'dubious', rule: ended('loss', 'timeout') },
] as const satisfies readonly FlairDefinition[];

export type FlairEntry = (typeof FLAIR)[number];

export type FlairId = FlairEntry['id'];

/** The version a flair is backfilled at (backfill spec §1): its `backfill`, or 1 when absent. */
export function flairBackfillVersion(flair: FlairDefinition): number {
  return flair.backfill ?? 1;
}

/** `undefined` for an id no longer in the catalog: stored rows can outlive a removed flair. */
export function flairById(id: string): FlairEntry | undefined {
  return FLAIR.find((flair) => flair.id === id);
}

/**
 * The `flair.<id>` description. The return type is the compile-time check that every id has a
 * string in `i18n/en.ts`: an id without one fails the build.
 */
export function flairDescriptionKey(id: FlairId): MessageKey {
  return `flair.${id}`;
}

/** The `flair.category.<category>` title, checked against the strings in the same way. */
export function flairCategoryKey(category: FlairCategory): MessageKey {
  return `flair.category.${category}`;
}
