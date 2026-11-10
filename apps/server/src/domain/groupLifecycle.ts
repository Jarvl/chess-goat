import { and, eq, sql } from 'drizzle-orm';
import { challenges } from '../db/schema';
import type { Deps } from './deps';
import { getGroupByChatId, setBotMembership } from './groups';

/** The bot left, so pending challenges end and no card is edited. */
export async function cancelPendingChallengesForGroup(
  deps: Deps,
  groupId: number,
): Promise<number> {
  const rows = await deps.db
    .update(challenges)
    .set({ status: 'cancelled', resolvedAt: sql`now()` })
    .where(and(eq(challenges.groupId, groupId), eq(challenges.status, 'pending')))
    .returning({ id: challenges.id });
  return rows.length;
}

export async function markBotLeft(deps: Deps, telegramChatId: number): Promise<void> {
  const group = await getGroupByChatId(deps.db, telegramChatId);
  if (!group) return;
  await setBotMembership(deps.db, group.id, {
    botStatus: 'left',
    botIsAdmin: false,
    botCanPin: false,
  });
  await cancelPendingChallengesForGroup(deps, group.id);
}
