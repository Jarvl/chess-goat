import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges, groupMembers, users, type UserRow } from '../db/schema';
import { requireOwnBot } from './bots';
import { editCard, retireChallengeDm } from './challenges';
import { DomainError } from './errors';
import { getMember, isBlocked, markLeft, touchMember } from './members';

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

/** The "may play" rule: the bot and its owner are both members here and neither is blocked. */
export async function assertBotMayPlay(
  tx: DbOrTx,
  groupId: number,
  bot: Pick<UserRow, 'id' | 'ownerId'>,
): Promise<void> {
  const member = await getMember(tx, groupId, bot.id);
  if (member?.status !== 'member' || bot.ownerId === null) {
    throw forbidden('bot_not_in_group', 'this bot is not in the group');
  }
  const owner = await getMember(tx, groupId, bot.ownerId);
  if (owner?.status !== 'member') {
    throw forbidden('owner_not_member', "the bot's owner is not in the group");
  }
  if (await isBlocked(tx, groupId, bot.id)) throw forbidden('blocked', 'blocked in this group');
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

/** Blocking a bot affects that bot; blocking a person affects all their live bots. */
export async function botIdsAffectedByBlock(tx: DbOrTx, userId: number): Promise<number[]> {
  const rows = await tx
    .select({ id: users.id, ownerId: users.ownerId })
    .from(users)
    .where(and(isNull(users.deletedAt), or(eq(users.id, userId), eq(users.ownerId, userId))));
  return rows.filter((row) => row.ownerId !== null).map((row) => row.id);
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
    if (challenge.botPlayers < 2) {
      await editCard(tx, challenge);
      await retireChallengeDm(tx, challenge, status);
    }
  }
}
