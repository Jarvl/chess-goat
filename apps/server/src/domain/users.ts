import {
  MAX_WORN_FLAIR,
  PREFS_DEFAULTS,
  PrefsSchema,
  flairById,
  type FlairEntry,
  type Prefs,
} from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { users, type UserRow } from '../db/schema';
import { DomainError } from './errors';
import { queuePhotoRefresh } from './photos';

export type TelegramUserInfo = {
  telegramUserId: number;
  firstName: string;
  username?: string | null;
  languageCode?: string | null;
};

/** Upsert keyed by Telegram id; refreshes the display fields and `last_seen_at` (spec §8). */
export async function ensureUser(tx: DbOrTx, info: TelegramUserInfo): Promise<UserRow> {
  const fields = {
    firstName: info.firstName,
    username: info.username ?? null,
    languageCode: info.languageCode ?? null,
  };
  const [row] = await tx
    .insert(users)
    .values({ telegramUserId: info.telegramUserId, ...fields })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: { ...fields, lastSeenAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error('ensureUser returned no row');
  await queuePhotoRefresh(tx, row);
  return row;
}

export async function getUserById(tx: DbOrTx, id: number): Promise<UserRow | null> {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function requireUser(tx: DbOrTx, id: number): Promise<UserRow> {
  const row = await getUserById(tx, id);
  if (!row) throw new DomainError('not_found', 'user not found', { userId: id });
  return row;
}

/**
 * Stored preferences over the defaults; keys no longer in the schema are dropped. A
 * `confirmMoves: false` stored before #16 reads as `moveConfirmations: 'never'`, and a stored
 * `moveConfirmations` always wins over it (move confirmations spec).
 */
export function prefsOf(user: Pick<UserRow, 'prefs'>): Prefs {
  const stored = user.prefs as Partial<Prefs> & { confirmMoves?: unknown };
  const legacy: Partial<Prefs> =
    stored.confirmMoves === false ? { moveConfirmations: 'never' } : {};
  return PrefsSchema.parse({ ...PREFS_DEFAULTS, ...legacy, ...user.prefs });
}

/** PRD §7.7: DMs go only to users who allowed them in Telegram and keep notifications on. */
export function wantsDms(user: Pick<UserRow, 'prefs' | 'dmAllowed' | 'deletedAt'>): boolean {
  return user.dmAllowed && user.deletedAt === null && prefsOf(user).notifications;
}

/** Merges a validated patch over the stored preferences; unknown keys are dropped, bad values refused. */
export async function updatePrefs(
  tx: DbOrTx,
  userId: number,
  patch: Partial<Prefs>,
): Promise<Prefs> {
  const parsed = PrefsSchema.partial().safeParse(patch);
  if (!parsed.success) {
    throw new DomainError('validation', 'invalid preferences', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  const [row] = await tx
    .update(users)
    .set({ prefs: sql`${users.prefs} || ${JSON.stringify(parsed.data)}::jsonb` })
    .where(eq(users.id, userId))
    .returning();
  if (!row) throw new DomainError('not_found', 'user not found', { userId });
  return prefsOf(row);
}

export async function recordWriteAccess(
  tx: DbOrTx,
  userId: number,
  allowed: boolean,
): Promise<void> {
  await tx
    .update(users)
    .set({ dmAllowed: allowed, writeAccessAskedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function setDmAllowed(tx: DbOrTx, userId: number, allowed: boolean): Promise<void> {
  await tx.update(users).set({ dmAllowed: allowed }).where(eq(users.id, userId));
}

/** People are named by their Telegram handle; `first_name` only when they have no username. */
export function displayName(user: Pick<UserRow, 'firstName' | 'username' | 'deletedAt'>): string {
  if (user.deletedAt) return 'Deleted player';
  return user.username ? `@${user.username}` : user.firstName;
}

type Wearer = Pick<UserRow, 'deletedAt' | 'isEngine' | 'flairWorn'>;

/**
 * What a player wears, in slot order. Deleted players and the bot wear none; a stored id the catalog
 * no longer has is skipped, and a fourth is not worn: the app refuses a player with more.
 */
export function wornFlair(user: Wearer): FlairEntry[] {
  if (user.deletedAt || user.isEngine) return [];
  return user.flairWorn.flatMap((id) => flairById(id) ?? []).slice(0, MAX_WORN_FLAIR);
}

/** The worn flair's emoji run together (`👑🚶`), or `''` when none is worn. */
export function flairEmoji(user: Wearer): string {
  return wornFlair(user)
    .map((flair) => flair.emoji)
    .join('');
}

/** A player as the group chat names them: the display name, then their worn flair. */
export function nameWithFlair(
  user: Pick<UserRow, 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'flairWorn'>,
): string {
  const flair = flairEmoji(user);
  return flair ? `${displayName(user)} ${flair}` : displayName(user);
}
