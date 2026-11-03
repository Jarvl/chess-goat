import { blockUser, unblockUser } from './members';
import { botIdsAffectedByBlock, listGroupBots, settleBotChallenges } from './botGroups';
import { DomainError } from './errors';
import { type Deps } from './deps';
import { GroupSettingsSchema, type GroupSettings, type GroupSettingsDto } from '@chess-goat/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { adminActions, groupMembers, ratings, users, type GroupRow } from '../db/schema';
import { requireGroup, settingsOf, updateGroupSettings } from './groups';
import { toPlayerRef } from './players';

export async function groupSettingsDto(tx: DbOrTx, group: GroupRow): Promise<GroupSettingsDto> {
  const blocked = await tx
    .select({ user: users, rating: ratings })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(eq(groupMembers.groupId, group.id), isNotNull(groupMembers.blockedAt)))
    .orderBy(users.firstName);
  const bots = await listGroupBots(tx, group.id);
  const botRatings =
    bots.length === 0
      ? []
      : await tx
          .select()
          .from(ratings)
          .where(
            and(
              eq(ratings.groupId, group.id),
              inArray(
                ratings.userId,
                bots.map((bot) => bot.id),
              ),
            ),
          );
  const blockedBotIds = new Set(
    blocked.filter((row) => row.user.ownerId !== null).map((row) => row.user.id),
  );
  return {
    group: { id: group.publicId, title: group.title },
    settings: settingsOf(group),
    // Bots are listed, with their own block control, under `bots`.
    blocked: blocked
      .filter((row) => row.user.ownerId === null)
      .map((row) => toPlayerRef(row.user, row.rating)),
    bots: bots.map((bot) => ({
      ...toPlayerRef(bot, botRatings.find((rating) => rating.userId === bot.id) ?? null),
      blocked: blockedBotIds.has(bot.id),
    })),
    botIsAdmin: group.botIsAdmin,
    isForum: group.isForum,
  };
}

/** Settings write with the cross-field rule and an audit row (spec §7.11, §12). */
export async function adminUpdateSettings(
  deps: Deps,
  group: GroupRow,
  adminId: number,
  patch: Partial<GroupSettings>,
): Promise<GroupSettingsDto> {
  const merged = GroupSettingsSchema.parse({ ...settingsOf(group), ...patch });
  if (merged.cardTopicMode === 'fixed' && merged.fixedTopicId === null) {
    throw new DomainError('validation', 'a fixed topic needs a topic id', {
      issues: ['fixedTopicId'],
    });
  }
  await deps.db.transaction(async (tx) => {
    await updateGroupSettings(tx, group.id, merged);
    await tx.insert(adminActions).values({
      groupId: group.id,
      adminUserId: adminId,
      action: 'settings',
      details: patch as Record<string, unknown>,
    });
  });
  return groupSettingsDto(deps.db, await requireGroup(deps.db, group.id));
}

export async function adminBlock(
  deps: Deps,
  group: GroupRow,
  adminId: number,
  userId: number,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await blockUser(tx, group.id, userId, adminId);
    await settleBotChallenges(tx, group.id, await botIdsAffectedByBlock(tx, userId));
    await tx
      .insert(adminActions)
      .values({ groupId: group.id, adminUserId: adminId, action: 'block', targetUserId: userId });
  });
}

export async function adminUnblock(
  deps: Deps,
  group: GroupRow,
  adminId: number,
  userId: number,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await unblockUser(tx, group.id, userId);
    await tx
      .insert(adminActions)
      .values({ groupId: group.id, adminUserId: adminId, action: 'unblock', targetUserId: userId });
  });
}
