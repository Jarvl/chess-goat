import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { groups, jobs } from '../../db/schema';
import { buildRoundup } from '../../domain/botRoundup';
import { settingsOf } from '../../domain/groups';
import { renderRoundupCard } from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import { enqueue } from '../queue';
import type { JobHandler, JobHandlers } from '../types';
import { call, type TelegramHandlerContext } from './telegramCall';

const ROUNDUP_KEY = 'bot_roundup';
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const WEEK_MS = WEEK_SECONDS * 1000;
/** Monday, 17:00 UTC. */
const MONDAY = 1;
const ROUNDUP_HOUR = 17;

/** Whole seconds from `now` to the next Monday 17:00 UTC; at exactly that time, a week. */
export function secondsUntilNextRoundup(now: Date): number {
  const thisMonday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - ((now.getUTCDay() + 7 - MONDAY) % 7),
    ROUNDUP_HOUR,
  );
  let next = thisMonday;
  while (next <= now.getTime()) next += WEEK_MS;
  return Math.ceil((next - now.getTime()) / 1000);
}

/** Called at startup by the jobs role: makes sure one round-up job is pending. */
export async function ensureBotRoundupScheduled(db: DbOrTx): Promise<void> {
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupKey, ROUNDUP_KEY), isNull(jobs.doneAt)))
    .limit(1);
  if (pending) return;
  await enqueue(db, {
    kind: 'bot_roundup',
    dedupKey: ROUNDUP_KEY,
    delaySeconds: secondsUntilNextRoundup(new Date()),
  });
}

/**
 * Posts each opted-in group's week of bot games. The next run is armed first, so a failure below can
 * never stop the weekly schedule; a group whose send fails is skipped rather than retried, because
 * a retry would post again to every group that already got its message.
 */
const botRoundup =
  (ctx: TelegramHandlerContext): JobHandler =>
  async () => {
    const now = new Date();
    await enqueue(ctx.deps.db, {
      kind: 'bot_roundup',
      dedupKey: ROUNDUP_KEY,
      delaySeconds: secondsUntilNextRoundup(now),
    });
    const since = new Date(now.getTime() - WEEK_MS);
    const candidates = await ctx.deps.db
      .select()
      .from(groups)
      .where(
        and(ne(groups.botStatus, 'left'), sql`(${groups.settings} ->> 'botRoundup') = 'true'`),
      );
    for (const group of candidates) {
      try {
        const roundup = await buildRoundup(ctx.deps.db, group.id, since);
        if (!roundup) continue;
        const settings = settingsOf(group);
        const rendered = renderRoundupCard({
          group: group.title,
          ...roundup,
          botsLink: miniAppLink(ctx.config, { kind: 'bots', groupId: group.publicId }),
          lobbyLink: miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
        });
        const result = await call(ctx, group.telegramChatId, () =>
          ctx.api.sendMessage(group.telegramChatId, rendered.text, {
            entities: rendered.entities,
            reply_markup: rendered.reply_markup,
            message_thread_id:
              (settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : null) ?? undefined,
          }),
        );
        if (!result.ok) {
          ctx.deps.log.warn(
            { groupId: group.id, failure: result.failure },
            'bot round-up not sent',
          );
        }
      } catch (err) {
        ctx.deps.log.warn({ err, groupId: group.id }, 'bot round-up failed for a group');
      }
    }
  };

export function botRoundupJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return { bot_roundup: botRoundup(ctx) };
}
