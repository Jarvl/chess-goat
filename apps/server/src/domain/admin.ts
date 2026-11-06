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
  const members = await listGroupBots(tx, group.id);
  const memberRatings =
    members.length === 0
      ? []
      : await tx
          .select()
          .from(ratings)
          .where(
            and(
              eq(ratings.groupId, group.id),
              inArray(
                ratings.userId,
                members.map((bot) => bot.id),
              ),
            ),
          );
  const ratingOf = new Map(memberRatings.map((rating) => [rating.userId, rating]));
  // Members, plus bots an admin blocked that have since left: they must stay unblockable.
  const botRows = new Map(
    members.map((bot) => [bot.id, { user: bot, rating: ratingOf.get(bot.id) ?? null }]),
  );
  for (const row of blocked) {
    if (row.user.ownerId !== null && !row.user.deletedAt && !botRows.has(row.user.id)) {
      botRows.set(row.user.id, row);
    }
  }
  const ownBlocked = new Set(
    blocked.filter((row) => row.user.ownerId !== null).map((row) => row.user.id),
  );
  const blockedHumans = new Set(
    blocked.filter((row) => row.user.ownerId === null).map((row) => row.user.id),
  );
  const bots = [...botRows.values()]
    .sort((a, b) => a.user.firstName.localeCompare(b.user.firstName) || a.user.id - b.user.id)
    .map(({ user, rating }) => {
      const own = ownBlocked.has(user.id);
      const viaOwner = !own && user.ownerId !== null && blockedHumans.has(user.ownerId);
      return { ...toPlayerRef(user, rating), blocked: own || viaOwner, blockedViaOwner: viaOwner };
    });
  return {
    group: { id: group.publicId, title: group.title },
    settings: settingsOf(group),
    // Bots are listed, with their own block control, under `bots`.
    blocked: blocked
      .filter((row) => row.user.ownerId === null)
      .map((row) => toPlayerRef(row.user, row.rating)),
    bots,
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
