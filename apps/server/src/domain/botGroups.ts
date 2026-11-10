import { freshPlayerState } from '@chess-goat/shared';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  challenges,
  groupMembers,
  groups,
  ratings,
  users,
  type RatingRow,
  type UserRow,
} from '../db/schema';
import { listBots, requireOwnBot } from './bots';
import { settleInChat } from './challenges';
import { DomainError } from './errors';
import { getMember, isBlocked, markLeft, touchMember } from './members';
import { findableIn, ownerJoin, ownerMember } from './pairing';
import { isBot } from './playerKind';

const forbidden = (reason: 'owner_not_member' | 'blocked' | 'bot_not_in_group', message: string) =>
  new DomainError('forbidden', message, { reason });

/** An owner puts one of their bots into a group they are in. Idempotent. */
export async function addBotToGroup(
  tx: DbOrTx,
  ownerId: number,
  botId: number,
  groupId: number,
): Promise<void> {
  const bot = await requireOwnBot(tx, ownerId, botId);
  const owner = await getMember(tx, groupId, ownerId);
  if (owner?.status !== 'member') {
    throw forbidden('owner_not_member', 'join the group before adding a bot');
  }
  // `isBlocked` on the bot also covers a blocked owner.
  if (await isBlocked(tx, groupId, bot.id)) throw forbidden('blocked', 'blocked in this group');
  await touchMember(tx, groupId, bot.id);
}

/** Takes a bot out of a group and settles the challenges it was part of there. */
export async function removeBotFromGroup(
  tx: DbOrTx,
  ownerId: number,
  botId: number,
  groupId: number,
): Promise<void> {
  await requireOwnBot(tx, ownerId, botId);
  await markLeft(tx, groupId, botId);
  await settleBotChallenges(tx, groupId, [botId]);
}

export async function listGroupBots(tx: DbOrTx, groupId: number): Promise<UserRow[]> {
  const rows = await tx
    .select({ user: users })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.status, 'member'),
        isNull(users.deletedAt),
        sql`${users.ownerId} is not null`,
      ),
    )
    .orderBy(users.firstName, users.id);
  return rows.map((row) => row.user);
}

export type BotSort = 'rating' | 'active' | 'newest';
/** `stats` is the bot's ratings row here; null while it has never been rated. */
export type BotSearchRow = { bot: UserRow; rating: number; stats: RatingRow | null };
export type BotSearchOptions = {
  query?: string;
  /** Only this bot (still subject to the findable rules). */
  botId?: number;
  /** Leave this bot out (the searcher itself). */
  excludeId?: number;
  sort: BotSort;
  limit: number;
  /** The previous page's last `key` and `id`, from `nextCursor`. */
  cursor?: { key: number; id: number };
};
export type BotSearchPage = { rows: BotSearchRow[]; next: { key: number; id: number } | null };

/**
 * Live, unblocked member bots of a group (their owners unblocked too), best first by `sort`, with
 * keyset pagination on (sort key, id). Rating is the bot's rating here (the default if unrated).
 */
export async function searchGroupBots(
  tx: DbOrTx,
  groupId: number,
  opts: BotSearchOptions,
): Promise<BotSearchPage> {
  const rating = sql<number>`coalesce(${ratings.rating}, ${freshPlayerState().rating})`;
  const key =
    opts.sort === 'rating'
      ? rating
      : opts.sort === 'active'
        ? sql<number>`coalesce(floor(extract(epoch from ${users.lastActiveAt}) * 1000), -1)`
        : sql<number>`${users.id}`;
  const conditions = findableIn(groupId);
  const query = opts.query?.trim();
  if (query) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    conditions.push(sql`${users.firstName} ilike ${`%${escaped}%`} escape '\\'`);
  }
  if (opts.botId !== undefined) conditions.push(eq(users.id, opts.botId));
  if (opts.excludeId !== undefined) conditions.push(ne(users.id, opts.excludeId));
  if (opts.cursor) {
    conditions.push(sql`(${key}, ${users.id}) < (${opts.cursor.key}::float8, ${opts.cursor.id})`);
  }
  const found = await tx
    .select({ user: users, rating, stats: ratings, key: sql<number>`(${key})::float8` })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ownerMember, ownerJoin)
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(...conditions))
    .orderBy(sql`(${key}) desc`, sql`${users.id} desc`)
    .limit(opts.limit + 1);
  const page = found.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      bot: row.user,
      rating: Number(row.rating),
      stats: row.stats,
    })),
    next: found.length > opts.limit && last ? { key: Number(last.key), id: last.user.id } : null,
  };
}

/** Opaque keyset cursor: the sort key and id of the last bot on the page, plus the sort it is for. */
export const encodeBotCursor = (sort: BotSort, key: number, id: number): string =>
  Buffer.from(JSON.stringify([sort, key, id])).toString('base64url');

/** Reads a cursor made by `encodeBotCursor` for the same `sort`; anything else is `invalid_cursor`. */
export function decodeBotCursor(sort: BotSort, cursor: string): { key: number; id: number } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === sort &&
      typeof parsed[1] === 'number' &&
      Number.isFinite(parsed[1]) &&
      Number.isInteger(parsed[2])
    ) {
      return { key: parsed[1], id: parsed[2] as number };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError('validation', 'that cursor is not valid', { reason: 'invalid_cursor' });
}

/** Blocking a bot affects that bot; blocking a person affects all their live bots. */
export async function botIdsAffectedByBlock(tx: DbOrTx, userId: number): Promise<number[]> {
  const rows = await tx
    .select({ id: users.id, isEngine: users.isEngine, ownerId: users.ownerId })
    .from(users)
    .where(and(isNull(users.deletedAt), or(eq(users.id, userId), eq(users.ownerId, userId))));
  return rows.filter(isBot).map((row) => row.id);
}

/**
 * Settles the pending challenges in a group that any of these bots sent (cancelled) or were sent
 * (declined). Bot-vs-bot cards never reach the chat, so only challenges with a human get an edit.
 */
export async function settleBotChallenges(
  tx: DbOrTx,
  groupId: number,
  botIds: number[],
): Promise<void> {
  if (botIds.length === 0) return;
  const pending = await tx
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.groupId, groupId),
        eq(challenges.status, 'pending'),
        or(inArray(challenges.challengerId, botIds), inArray(challenges.opponentId, botIds)),
      ),
    )
    .orderBy(challenges.id)
    .for('update');
  for (const challenge of pending) {
    const status = botIds.includes(challenge.challengerId) ? 'cancelled' : 'declined';
    await tx
      .update(challenges)
      .set({ status, resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id));
    await settleInChat(tx, challenge, status);
  }
}

/**
 * The groups an owner may act in (a member, not blocked), by title, each with which of the owner's
 * live bots are in it. For the owner's agent: list_my_groups.
 */
export async function ownerGroups(
  tx: DbOrTx,
  ownerId: number,
): Promise<{ groupId: string; title: string; myBots: string[] }[]> {
  const mine = await tx
    .select({ id: groups.id, publicId: groups.publicId, title: groups.title })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(groupMembers.userId, ownerId),
        eq(groupMembers.status, 'member'),
        isNull(groupMembers.blockedAt),
      ),
    )
    .orderBy(asc(groups.title), asc(groups.id));
  if (mine.length === 0) return [];
  const bots = await listBots(tx, ownerId);
  const botIds = bots.map((bot) => bot.id);
  const placed =
    botIds.length === 0
      ? []
      : await tx
          .select({ groupId: groupMembers.groupId, botId: groupMembers.userId })
          .from(groupMembers)
          .where(
            and(
              inArray(groupMembers.userId, botIds),
              inArray(
                groupMembers.groupId,
                mine.map((g) => g.id),
              ),
              eq(groupMembers.status, 'member'),
            ),
          );
  return mine.map((group) => ({
    groupId: group.publicId,
    title: group.title,
    myBots: bots
      .filter((bot) => placed.some((p) => p.groupId === group.id && p.botId === bot.id))
      .map((bot) => bot.firstName),
  }));
}
