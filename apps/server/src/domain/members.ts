import type { PlayerRef } from '@chess-goat/shared';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { groupMembers, ratings, users, type GroupMemberRow, type UserRow } from '../db/schema';
import { toPlayerRef } from './players';

/** Membership evidence from the user's own activity in the group (spec §5.6 step 4). */
export async function touchMember(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  options: { verified?: boolean } = {},
): Promise<void> {
  const verified = options.verified ? { verifiedAt: sql`now()` } : {};
  await tx
    .insert(groupMembers)
    .values({ groupId, userId, ...verified })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { status: 'member', lastSeenAt: sql`now()`, ...verified },
    });
}

/** `verified` records that the verdict came from Telegram, so a denial is cached like a grant. */
export async function markLeft(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  options: { verified?: boolean } = {},
): Promise<void> {
  const verified = options.verified ? { verifiedAt: sql`now()` } : {};
  await tx
    .insert(groupMembers)
    .values({ groupId, userId, status: 'left', ...verified })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { status: 'left', ...verified },
    });
}

export async function getMember(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<GroupMemberRow | null> {
  const [row] = await tx
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function isBlocked(tx: DbOrTx, groupId: number, userId: number): Promise<boolean> {
  const member = await getMember(tx, groupId, userId);
  return member?.blockedAt != null;
}

export async function blockUser(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  byAdminId: number,
): Promise<void> {
  await tx
    .insert(groupMembers)
    .values({ groupId, userId, blockedAt: sql`now()`, blockedBy: byAdminId })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { blockedAt: sql`now()`, blockedBy: byAdminId },
    });
}

export async function unblockUser(tx: DbOrTx, groupId: number, userId: number): Promise<void> {
  await tx
    .update(groupMembers)
    .set({ blockedAt: null, blockedBy: null })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

/** The opponent picker: members the bot has seen here, newest first (spec §5.6, PRD §7.2). */
export async function listKnownPlayers(
  tx: DbOrTx,
  groupId: number,
  options: { excludeUserId?: number; limit?: number } = {},
): Promise<PlayerRef[]> {
  const conditions = [
    eq(groupMembers.groupId, groupId),
    eq(groupMembers.status, 'member'),
    isNull(groupMembers.blockedAt),
    isNull(users.deletedAt),
  ];
  if (options.excludeUserId !== undefined) conditions.push(ne(users.id, options.excludeUserId));
  const rows = await tx
    .select({ user: users, rating: ratings })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(...conditions))
    .orderBy(desc(groupMembers.lastSeenAt), users.id)
    .limit(options.limit ?? 50);
  return rows.map((row) => toPlayerRef(row.user, row.rating));
}

/**
 * A current member named by an @mention. Telegram gives bots no way to turn a username into a
 * user, so only people the bot has already seen in this group can be found; handles compare
 * without case, as Telegram's do.
 */
export async function findMemberByUsername(
  tx: DbOrTx,
  groupId: number,
  username: string,
): Promise<UserRow | null> {
  const [row] = await tx
    .select({ user: users })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.status, 'member'),
        isNull(users.deletedAt),
        sql`lower(${users.username}) = lower(${username})`,
      ),
    )
    .orderBy(desc(groupMembers.lastSeenAt))
    .limit(1);
  return row?.user ?? null;
}
