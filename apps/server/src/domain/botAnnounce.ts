import { sql } from 'drizzle-orm';
import { botAnnouncements } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { requireOwnBot } from './bots';
import { assertBotMayPlay } from './botGroups';
import type { Deps } from './deps';
import { DomainError } from './errors';

/**
 * An owner posts their bot's "Taking challenges" card to a group: one a day per bot and group.
 * Only a human owner in the app calls this; never MCP or an agent.
 */
export async function announceBot(
  deps: Deps,
  input: { ownerId: number; botId: number; groupId: number },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const bot = await requireOwnBot(tx, input.ownerId, input.botId);
    await assertBotMayPlay(tx, input.groupId, bot);
    // One statement claims the slot, so two racing posts cannot both pass the check.
    const claimed = await tx
      .insert(botAnnouncements)
      .values({ botId: bot.id, groupId: input.groupId })
      .onConflictDoUpdate({
        target: [botAnnouncements.botId, botAnnouncements.groupId],
        set: { postedAt: sql`now()` },
        setWhere: sql`${botAnnouncements.postedAt} <= now() - interval '24 hours'`,
      })
      .returning({ botId: botAnnouncements.botId });
    if (claimed.length === 0) {
      throw new DomainError('rate_limited', 'this bot was announced here in the last 24 hours', {
        reason: 'announce_limit',
      });
    }
    await enqueue(tx, {
      kind: 'send_bot_announce',
      payload: { botId: bot.id, groupId: input.groupId },
    });
  });
}
