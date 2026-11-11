import { freshPlayerState, GLICKO2, isProvisional, type GameSummary } from '@chess-goat/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { dbNow, type DbOrTx } from '../db/client';
import { games, groupMembers, groups, ratings, users, type UserRow } from '../db/schema';
import { clearBotNotes, validPersona } from './botNotes';
import { deletedBotFields, leavePlay, lockPlay } from './account';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { MAX_BOTS_PER_OWNER } from './limits';
import { eraseBotTurns, lockOwnerTurns } from './turnLeases';
import { gameSummaryRows, toGameSummary } from './summaries';
import { displayName, lockLiveHumanOwner } from './users';

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]{0,31}$/u;
const RESERVED_NAMES = new Set(['stockfish', 'deleted player', 'deleted bot']);
export const TAGLINE_MAX = 80;

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
  input: { name: string; tagline?: string | null; persona?: string | null },
): Promise<UserRow> {
  const name = validName(input.name);
  const tagline = validTagline(input.tagline);
  const persona = validPersona(input.persona);

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
      .values({ firstName: name, tagline, persona, ownerId, ownerName: displayName(owner) })
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
  const [match] = await tx
    .select({ id: users.id })
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
  if (!match) throw notFound();
  // One ownership predicate: the name only finds the id.
  return requireOwnBot(tx, ownerId, match.id);
}

export async function updateBot(
  tx: DbOrTx,
  ownerId: number,
  botId: number,
  patch: { name?: string; tagline?: string | null; persona?: string | null; clearNotes?: boolean },
): Promise<UserRow> {
  await requireOwnBot(tx, ownerId, botId);
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.name !== undefined) set.firstName = validName(patch.name);
  if (patch.tagline !== undefined) set.tagline = validTagline(patch.tagline);
  if (patch.persona !== undefined) set.persona = validPersona(patch.persona);
  if (patch.clearNotes) await clearBotNotes(tx, botId);
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
    // Same lock order as `deleteMyData`: the owner's claim lock, games, challenges, then the
    // `users` row and, last, its turn rows.
    await lockOwnerTurns(tx, ownerId);
    const now = await dbNow(tx);
    const play = await lockPlay(tx, [botId]);
    // Re-checked under the row lock: a concurrent deletion of the same bot leaves nothing to do.
    const [row] = await tx
      .update(users)
      .set(deletedBotFields(now))
      .where(and(eq(users.id, botId), eq(users.ownerId, ownerId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (!row) throw new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
    // A bot has no DMs to retire.
    const publicIds = await leavePlay(tx, play, now, []);
    // After its games end; soft deletion fires no cascade.
    await eraseBotTurns(tx, [botId]);
    return publicIds;
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

export type BotView = {
  id: number;
  name: string;
  label: string;
  tagline: string | null;
  lastActiveAt: string | null;
  groups: { groupId: string; title: string; rating: number; gamesPlayed: number }[];
  liveGames: number;
};

/** The bots' views, reading memberships, ratings and live games in one pass each. */
export async function botViews(tx: DbOrTx, bots: readonly UserRow[]): Promise<BotView[]> {
  if (bots.length === 0) return [];
  const ids = bots.map((bot) => bot.id);
  const memberships = await tx
    .select({
      botId: groupMembers.userId,
      groupId: groups.publicId,
      title: groups.title,
      rating: ratings.rating,
      gamesPlayed: ratings.gamesPlayed,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .leftJoin(
      ratings,
      and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, groupMembers.userId)),
    )
    .where(and(inArray(groupMembers.userId, ids), eq(groupMembers.status, 'member')))
    .orderBy(asc(groups.title), asc(groups.id));
  // Counted in SQL, a side at a time: a bot never plays both sides of one game.
  const liveOn = (side: typeof games.whiteId | typeof games.blackId) =>
    tx
      .select({ id: side, n: sql<number>`count(*)::int` })
      .from(games)
      .where(and(eq(games.status, 'active'), inArray(side, ids)))
      .groupBy(side);
  const liveByBot = new Map<number, number>();
  for (const { id, n } of [...(await liveOn(games.whiteId)), ...(await liveOn(games.blackId))]) {
    liveByBot.set(id, (liveByBot.get(id) ?? 0) + n);
  }
  const start = freshPlayerState().rating;
  return bots.map((bot) => ({
    id: bot.id,
    name: bot.firstName,
    label: displayName(bot),
    tagline: bot.tagline,
    lastActiveAt: bot.lastActiveAt?.toISOString() ?? null,
    groups: memberships
      .filter((m) => m.botId === bot.id)
      .map((m) => ({
        groupId: m.groupId,
        title: m.title,
        rating: Math.round(m.rating ?? start),
        gamesPlayed: m.gamesPlayed ?? 0,
      })),
    liveGames: liveByBot.get(bot.id) ?? 0,
  }));
}

const RECENT_PER_BOT = 5;

const dashboardOwner = alias(groupMembers, 'dashboard_owner');

export type OwnerBotGroup = BotView['groups'][number] & {
  provisional: boolean;
  /** The owner is a member there too, so the bot's page in that group is theirs to open. */
  ownerIsMember: boolean;
};

/** The owner's bots with each one's last finished games, for the dashboard. */
export async function ownerBots(
  tx: DbOrTx,
  ownerId: number,
): Promise<(Omit<BotView, 'groups'> & { groups: OwnerBotGroup[]; recent: GameSummary[] })[]> {
  const views = await botViews(tx, await listBots(tx, ownerId));
  if (views.length === 0) return [];
  const standing = await tx
    .select({
      botId: groupMembers.userId,
      groupId: groups.publicId,
      rd: ratings.rd,
      ownerStatus: dashboardOwner.status,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .leftJoin(
      ratings,
      and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, groupMembers.userId)),
    )
    .leftJoin(
      dashboardOwner,
      and(eq(dashboardOwner.groupId, groupMembers.groupId), eq(dashboardOwner.userId, ownerId)),
    )
    .where(
      and(
        inArray(
          groupMembers.userId,
          views.map((view) => view.id),
        ),
        eq(groupMembers.status, 'member'),
      ),
    );
  const key = (botId: number, groupId: string) => `${botId}:${groupId}`;
  const standingOf = new Map(standing.map((row) => [key(row.botId, row.groupId), row]));
  // One bot at a time: a dashboard of many bots must not take a connection per bot at once.
  const out = [];
  for (const view of views) {
    const rows = await gameSummaryRows(
      tx,
      and(
        eq(games.status, 'finished'),
        isNull(games.voidedAt),
        or(eq(games.whiteId, view.id), eq(games.blackId, view.id)),
      ),
      [desc(games.finishedAt), desc(games.id)],
      RECENT_PER_BOT,
    );
    out.push({
      ...view,
      groups: view.groups.map((group) => {
        const row = standingOf.get(key(view.id, group.groupId));
        return {
          ...group,
          provisional: isProvisional(row?.rd ?? GLICKO2.initialRd),
          ownerIsMember: row?.ownerStatus === 'member',
        };
      }),
      recent: rows.map((row) => toGameSummary(row, ownerId)),
    });
  }
  return out;
}
