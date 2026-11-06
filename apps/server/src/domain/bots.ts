import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { users, type UserRow } from '../db/schema';
import { deletedBotFields, leavePlay, lockPlay } from './account';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { MAX_BOTS_PER_OWNER } from './limits';
import { displayName, lockLiveHumanOwner } from './users';

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]{0,31}$/u;
const RESERVED_NAMES = new Set(['stockfish', 'deleted player', 'deleted bot']);
const TAGLINE_MAX = 80;

export function normaliseBotName(raw: string): string {
  return raw.trim().replace(/ {2,}/g, ' ');
}

function validName(raw: string): string {
  const name = normaliseBotName(raw);
  if (!NAME_PATTERN.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
    throw new DomainError('validation', 'invalid bot name', { reason: 'invalid_bot_name' });
  }
  return name;
}

function validTagline(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const tagline = raw.trim();
  if (tagline === '') return null;
  if (tagline.length > TAGLINE_MAX || /[\r\n\u2028\u2029]/.test(tagline)) {
    throw new DomainError('validation', 'invalid tagline', { reason: 'invalid_tagline' });
  }
  return tagline;
}

function isBotNameViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const { code, constraint, constraint_name } = e as Record<string, unknown>;
    if (code === '23505' && (constraint ?? constraint_name) === 'users_bot_name') return true;
  }
  return false;
}

const nameTaken = () =>
  new DomainError('validation', 'bot name taken', { reason: 'bot_name_taken' });

export async function createBot(
  tx: DbOrTx,
  ownerId: number,
  input: { name: string; tagline?: string | null },
): Promise<UserRow> {
  const name = validName(input.name);
  const tagline = validTagline(input.tagline);

  const owner = await lockLiveHumanOwner(tx, ownerId);
  const [counted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.ownerId, ownerId), isNull(users.deletedAt)));
  if ((counted?.n ?? 0) >= MAX_BOTS_PER_OWNER) {
    throw new DomainError('limit_exceeded', 'too many bots', {
      reason: 'too_many_bots',
      limit: MAX_BOTS_PER_OWNER,
    });
  }
  try {
    const [row] = await tx
      .insert(users)
      .values({ firstName: name, tagline, ownerId, ownerName: displayName(owner) })
      .returning();
    if (!row) throw new Error('createBot returned no row');
    return row;
  } catch (error) {
    if (isBotNameViolation(error)) throw nameTaken();
    throw error;
  }
}

export async function requireOwnBot(tx: DbOrTx, ownerId: number, botId: number): Promise<UserRow> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, botId), eq(users.ownerId, ownerId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) throw new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
  return row;
}

/**
 * One of the owner's live bots, by name (case-insensitive, after `normaliseBotName`) or numeric
 * id. Anything else, including the owner's own user id or another owner's bot, is `bot_not_found`.
 */
export async function resolveOwnBot(
  tx: DbOrTx,
  ownerId: number,
  ref: string | number,
): Promise<UserRow> {
  const notFound = () => new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
  if (typeof ref === 'number') {
    if (!Number.isSafeInteger(ref)) throw notFound();
    return requireOwnBot(tx, ownerId, ref);
  }
  const name = normaliseBotName(ref);
  if (name === '') throw notFound();
  const [row] = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.ownerId, ownerId),
        isNull(users.deletedAt),
        sql`lower(${users.firstName}) = lower(${name})`,
      ),
    )
    .orderBy(asc(users.id))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function updateBot(
  tx: DbOrTx,
  ownerId: number,
  botId: number,
  patch: { name?: string; tagline?: string | null },
): Promise<UserRow> {
  await requireOwnBot(tx, ownerId, botId);
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.name !== undefined) set.firstName = validName(patch.name);
  if (patch.tagline !== undefined) set.tagline = validTagline(patch.tagline);
  if (Object.keys(set).length === 0) return requireOwnBot(tx, ownerId, botId);
  try {
    const [row] = await tx
      .update(users)
      .set(set)
      .where(and(eq(users.id, botId), eq(users.ownerId, ownerId), isNull(users.deletedAt)))
      .returning();
    if (!row) throw new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
    return row;
  } catch (error) {
    if (isBotNameViolation(error)) throw nameTaken();
    throw error;
  }
}

/**
 * Deletes one of the owner's live bots: resigns its live games, settles its pending challenges and
 * anonymises its row, keeping the id so finished games still name it. Frees its name and its slot.
 * Returns how many live games it resigned.
 */
export async function deleteBot(deps: Deps, ownerId: number, botId: number): Promise<number> {
  const finished = await deps.db.transaction(async (tx) => {
    await requireOwnBot(tx, ownerId, botId);
    const now = await dbNow(tx);
    // Same lock order as `deleteMyData`: games, then challenges, then the `users` row.
    const play = await lockPlay(tx, [botId]);
    // Re-checked under the row lock: a concurrent deletion of the same bot leaves nothing to do.
    const [row] = await tx
      .update(users)
      .set(deletedBotFields(now))
      .where(and(eq(users.id, botId), eq(users.ownerId, ownerId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (!row) throw new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
    // A bot has no DMs to retire.
    return leavePlay(tx, play, now, []);
  });
  for (const publicId of finished) deps.bus.publish(publicId);
  return finished.length;
}

export function listBots(tx: DbOrTx, ownerId: number): Promise<UserRow[]> {
  return tx
    .select()
    .from(users)
    .where(and(eq(users.ownerId, ownerId), isNull(users.deletedAt)))
    .orderBy(asc(users.createdAt), asc(users.id));
}

/** How many of a game's two players are bots; `b` is null for a challenge with no opponent yet. */
export function countBotPlayers(
  a: Pick<UserRow, 'ownerId'>,
  b: Pick<UserRow, 'ownerId'> | null,
): 0 | 1 | 2 {
  return ((a.ownerId !== null ? 1 : 0) + (b && b.ownerId !== null ? 1 : 0)) as 0 | 1 | 2;
}

/**
 * Record that a bot just did something. Writes at most once a minute so a busy bot doesn't churn
 * its row. Humans and the engine have no owner, so they never match.
 */
export async function touchBotActivity(tx: DbOrTx, botId: number): Promise<void> {
  await tx
    .update(users)
    .set({ lastActiveAt: sql`now()` })
    .where(
      and(
        eq(users.id, botId),
        isNotNull(users.ownerId),
        or(isNull(users.lastActiveAt), sql`${users.lastActiveAt} < now() - interval '60 seconds'`),
      ),
    );
}
