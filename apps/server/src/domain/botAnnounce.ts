import { and, eq, sql } from 'drizzle-orm';
import { botAnnouncements, users } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { requireOwnBot } from './bots';
import { mayPlay } from './pairing';
import type { Deps } from './deps';
import { DomainError } from './errors';

/**
 * An owner posts a bot's "Taking challenges" card to a group: one a day per owner and group, whichever
 * of their bots it is for.
 * Only a human owner in the app calls this; never MCP or an agent.
 */
export async function announceBot(
  deps: Deps,
  input: { ownerId: number; botId: number; groupId: number },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const bot = await requireOwnBot(tx, input.ownerId, input.botId);
    await mayPlay(tx, input.groupId, bot);
    // The owner's row is locked first, so two racing posts for any of their bots take turns and
    // the second sees the first's claim.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.ownerId)).for('update');
    const [recent] = await tx
      .select({ botId: botAnnouncements.botId })
      .from(botAnnouncements)
      .innerJoin(users, eq(users.id, botAnnouncements.botId))
      .where(
        and(
          eq(users.ownerId, input.ownerId),
          eq(botAnnouncements.groupId, input.groupId),
          sql`${botAnnouncements.postedAt} > now() - interval '24 hours'`,
        ),
      )
      .limit(1);
    if (recent) {
      throw new DomainError(
        'rate_limited',
        'a bot of this owner was announced here in the last 24 hours',
        {
          reason: 'announce_limit',
        },
      );
    }
    await tx
      .insert(botAnnouncements)
      .values({ botId: bot.id, groupId: input.groupId })
      .onConflictDoUpdate({
        target: [botAnnouncements.botId, botAnnouncements.groupId],
        set: { postedAt: sql`now()` },
      });
    await enqueue(tx, {
      kind: 'send_bot_announce',
      payload: { botId: bot.id, groupId: input.groupId },
    });
  });
}
