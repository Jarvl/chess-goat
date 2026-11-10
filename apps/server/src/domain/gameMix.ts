import type { Colour } from '@chess-goat/shared';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { UserRow } from '../db/schema';
import { isBot } from './playerKind';

/**
 * Game Mix: who is playing a game or challenge, by Player Kind (humans only, a human against a
 * bot, or bots only), and the Game Audience that follows from it. The one module that reads the
 * stored `bot_players` count (a guard test keeps it so); everything else asks it a question.
 *
 * The engine is not a bot here: an engine game is a humans-only mix, and is told apart by its
 * `engineLevel`.
 */
export type GameMix = 'humans' | 'mixed' | 'bots';

/** Anything that stores the count: a game or a challenge row. */
type Counted = { botPlayers: number };

export function mixOf(row: Counted): GameMix {
  return row.botPlayers === 0 ? 'humans' : row.botPlayers === 1 ? 'mixed' : 'bots';
}

/** The mix of two players; `b` is null for a challenge that names no one yet. */
export function mixOfPlayers(
  a: Pick<UserRow, 'isEngine' | 'ownerId'>,
  b: Pick<UserRow, 'isEngine' | 'ownerId'> | null,
): GameMix {
  const bots = (isBot(a) ? 1 : 0) + (b && isBot(b) ? 1 : 0);
  return mixOf({ botPlayers: bots });
}

/** The count to store for a mix, in `games.bot_players` / `challenges.bot_players`. */
export function storedBotPlayers(mix: GameMix): 0 | 1 | 2 {
  return mix === 'humans' ? 0 : mix === 'mixed' ? 1 : 2;
}

export type GameAudience = {
  /** The group chat hears about it: card, card edits, result photo, challenge DMs. */
  chat: boolean;
  /** It may be imported to Lichess when it ends (other end conditions aside). */
  importable: boolean;
};

/**
 * Who hears about a game or challenge. Bots-only play is silent; an engine game and any
 * game with a bot in it (the shared Lichess quota) are never imported.
 * Whether a particular player gets DMs is Player Kind's question (`can(user, 'getDms')`).
 */
export function audienceOf(row: Counted & { engineLevel?: string | null }): GameAudience {
  const mix = mixOf(row);
  const engine = row.engineLevel != null;
  return { chat: !engine && mix !== 'bots', importable: !engine && mix === 'humans' };
}

/**
 * The side whose rating a rated game leaves alone: in a human-against-bot game only the bot is
 * rated, so the human's colour is frozen. Undefined for any other mix.
 */
export function frozenSide(mix: GameMix, whiteIsBot: boolean): Colour | undefined {
  if (mix !== 'mixed') return undefined;
  return whiteIsBot ? 'black' : 'white';
}

/** Query filters on a `bot_players` column, for the lobby, the scanners and the bot roundup. */
export const mixFilter = {
  botsOnly: (column: AnyColumn): SQL => sql`${column} = 2`,
  notBotsOnly: (column: AnyColumn): SQL => sql`${column} <> 2`,
  withABot: (column: AnyColumn): SQL => sql`${column} > 0`,
};
