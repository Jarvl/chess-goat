import type { PlayerKind } from '@chess-goat/shared';
import type { UserRow } from '../db/schema';

/**
 * Player Kind: a person, the engine, or a bot. The one place that reads `users.is_engine` and
 * `users.owner_id` to tell them apart (a guard test keeps it so), and the one table of what each
 * kind can do.
 */

type Kinded = Pick<UserRow, 'isEngine' | 'ownerId'>;

export function kindOf(user: Kinded): PlayerKind {
  if (user.isEngine) return 'engine';
  return user.ownerId !== null ? 'bot' : 'human';
}

export const isHuman = (user: Kinded): boolean => kindOf(user) === 'human';
export const isEngine = (user: Kinded): boolean => kindOf(user) === 'engine';
export const isBot = (user: Kinded): boolean => kindOf(user) === 'bot';

/**
 * What each kind can do. This reproduces the rules as they stood when they were gathered here,
 * including where they disagree; each such row says so. Changing one is a decision of its own.
 */
const CAN = {
  /** Wear and be awarded flair. */
  wearFlair: { human: true, engine: false, bot: false },
  /**
   * Be sent DMs (subject to the person's own settings).
   * Odd: the engine is allowed here; it gets none only because its row never allows DMs.
   */
  getDms: { human: true, engine: true, bot: false },
  /**
   * Show a stored profile photo.
   * Odd: bots are allowed; they show none only because a bot has no Telegram photo to store.
   */
  showPhoto: { human: true, engine: false, bot: true },
  /** Sign in to the Mini App, and own bots. */
  actAsPerson: { human: true, engine: false, bot: false },
} as const satisfies Record<string, Record<PlayerKind, boolean>>;

export type Capability = keyof typeof CAN;

export function can(user: Kinded, capability: Capability): boolean {
  return CAN[capability][kindOf(user)];
}
