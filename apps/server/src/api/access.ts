import type { GameRow, GroupRow, UserRow } from '../db/schema';
import { DomainError } from '../domain/errors';
import { colourOf } from '../domain/gameDto';
import { requireGroup } from '../domain/groups';
import type { ApiContext } from './context';

/** Authorization matrix, membership half. */
export async function requireMember(
  ctx: ApiContext,
  group: GroupRow,
  user: UserRow,
): Promise<void> {
  if (!(await ctx.membership.verify(group, user))) {
    throw new DomainError('forbidden', 'not a member of this group', { reason: 'locked' });
  }
}

/** The two players always; otherwise a verified member of the game's group. */
export async function requireGameAccess(
  ctx: ApiContext,
  game: GameRow,
  user: UserRow,
): Promise<GroupRow> {
  const group = await requireGroup(ctx.deps.db, game.groupId);
  if (colourOf(game, user.id)) return group;
  await requireMember(ctx, group, user);
  return group;
}

export async function requireAdmin(ctx: ApiContext, group: GroupRow, user: UserRow): Promise<void> {
  if (!(await ctx.membership.isAdmin(group, user))) {
    throw new DomainError('forbidden', 'group administrators only');
  }
}
