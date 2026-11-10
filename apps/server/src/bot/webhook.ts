import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Hono } from 'hono';
import type { Config } from '../config';
import { telegramUpdates } from '../db/schema';
import type { Deps } from '../domain/deps';
import type { Metrics } from '../metrics';

const MAX_UPDATE_BYTES = 1_048_576;
/** An update marked received but not processed for this long is an attempt that died mid-way. */
const STALE_ATTEMPT_MS = 60_000;
/** An update Telegram delivers this long after it was sent is logged, to explain late answers. */
const LATE_UPDATE_SECONDS = 60;
/** The update types whose `date` is when the user acted (a tap's `message.date` is not). */
const DATED_TYPES = new Set(['message', 'my_chat_member', 'chat_member']);

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function updateType(update: Update): string {
  return Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
}

/** Seconds since the user acted, for the update types that say; null for the rest. */
function ageSeconds(update: Update, type: string): number | null {
  if (!DATED_TYPES.has(type)) return null;
  const date = (update as unknown as Record<string, { date?: unknown } | undefined>)[type]?.date;
  return typeof date === 'number' ? Math.floor(Date.now() / 1000) - date : null;
}

/**
 * Secret header, update_id idempotency, 500 on failure so Telegram retries. The marker
 * is written before the handler and completed after it; a marker that stays incomplete for a
 * minute (a process that died in between) is claimed again by the retry instead of acknowledged.
 */
export function webhookRoutes(bot: Bot, deps: Deps, config: Config, metrics?: Metrics): Hono {
  const app = new Hono();
  app.post('/telegram/webhook', async (c) => {
    if (!secretMatches(c.req.header('x-telegram-bot-api-secret-token'), config.WEBHOOK_SECRET))
      return c.body(null, 401);
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPDATE_BYTES) return c.body(null, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_UPDATE_BYTES) return c.body(null, 413);
    let update: Update;
    try {
      update = JSON.parse(raw) as Update;
    } catch {
      return c.body(null, 400);
    }
    if (typeof update?.update_id !== 'number') return c.body(null, 400);
    const type = updateType(update);
    metrics?.webhookUpdates.inc({ type });
    const age = ageSeconds(update, type);
    if (age !== null && age > LATE_UPDATE_SECONDS)
      deps.log.warn({ updateId: update.update_id, type, ageSeconds: age }, 'late update');

    const inserted = await deps.db
      .insert(telegramUpdates)
      .values({ updateId: update.update_id })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.updateId });
    if (inserted.length === 0) {
      // A duplicate: acknowledged, unless the earlier attempt never finished and is stale.
      const claimed = await deps.db
        .update(telegramUpdates)
        .set({ receivedAt: sql`now()` })
        .where(
          sql`${telegramUpdates.updateId} = ${update.update_id} and ${telegramUpdates.processedAt} is null and ${telegramUpdates.receivedAt} < now() - make_interval(secs => ${STALE_ATTEMPT_MS / 1000})`,
        )
        .returning({ updateId: telegramUpdates.updateId });
      if (claimed.length === 0) return c.body(null, 200);
      deps.log.warn({ updateId: update.update_id }, 'reprocessing an update whose attempt died');
    }
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      await deps.db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, update.update_id));
      deps.log.error({ err: error, updateId: update.update_id }, 'update handler failed');
      return c.body(null, 500);
    }
    await deps.db
      .update(telegramUpdates)
      .set({ processedAt: sql`now()` })
      .where(eq(telegramUpdates.updateId, update.update_id));
    return c.body(null, 200);
  });
  return app;
}
