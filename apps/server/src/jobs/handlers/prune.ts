import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { jobs, telegramUpdates } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { enqueue } from '../queue';
import type { JobHandler } from '../types';

const PRUNE_KEY = 'prune';
const DAY_SECONDS = 86_400;

/** Called at startup by the jobs role: makes sure one prune job is pending. */
/** Arms the daily prune once; a prune already scheduled (by this or another replica) is left alone. */
export async function ensurePruneScheduled(db: DbOrTx): Promise<void> {
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupKey, PRUNE_KEY), isNull(jobs.doneAt)))
    .limit(1);
  if (pending) return;
  await enqueue(db, { kind: 'prune', dedupKey: PRUNE_KEY });
}

/**
 * Daily prune: `telegram_updates` older than 7 days, done jobs older than 30 days. Re-arming
 * moves this very row's `run_at` to tomorrow, which the worker then leaves pending instead of done.
 */
export function pruneHandler(deps: Deps): JobHandler {
  return async () => {
    await deps.db
      .delete(telegramUpdates)
      .where(sql`${telegramUpdates.receivedAt} < now() - interval '7 days'`);
    await deps.db
      .delete(jobs)
      .where(and(isNotNull(jobs.doneAt), sql`${jobs.doneAt} < now() - interval '30 days'`));
    await enqueue(deps.db, { kind: 'prune', dedupKey: PRUNE_KEY, delaySeconds: DAY_SECONDS });
  };
}
