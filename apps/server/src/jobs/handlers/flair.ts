import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jobs } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { awardFlairForGame } from '../../flair/award';
import { canRunBackfill, runFlairBackfill } from '../../flair/backfill';
import type { JobHandler } from '../types';

const Payload = z.object({ gameId: z.number().int() });

/**
 * Scores the players of a finished game. It runs outside the transaction that
 * ended the game, so a rule that throws fails only this job, never the game ending.
 */
export function awardFlairHandler(deps: Deps): JobHandler {
  return async ({ job }) => {
    const { gameId } = Payload.parse(job.payload);
    await deps.db.transaction((tx) => awardFlairForGame(tx, gameId));
  };
}

const BackfillPayload = z.object({
  flair: z.array(z.object({ id: z.string(), version: z.number().int() })),
  /** The last player a previous run walked; absent before the first. */
  afterUserId: z.number().int().optional(),
});

/**
 * Backfills the payload's flair for every player, `chunk` players per run. The
 * worker runs its jobs one at a time, so between chunks the job saves its place in its payload and
 * asks to run again at once: other due jobs (bot moves, messages) run in between, a retry resumes
 * where it stopped, and no attempt is counted. A job from a newer build, naming flair or versions
 * this one lacks, waits for a newer worker instead.
 */
export function backfillFlairHandler(
  deps: Deps,
  { chunk = 50 }: { chunk?: number } = {},
): JobHandler {
  return async ({ job, log }) => {
    const payload = BackfillPayload.parse(job.payload);
    if (!canRunBackfill(payload.flair)) return { outcome: 'retry', delayMs: 30_000 };
    const summary = await runFlairBackfill(deps.db, payload.flair, {
      afterUserId: payload.afterUserId,
      limit: chunk,
    });
    log.info(
      { ...summary },
      summary.next === null ? 'flair backfill done' : 'flair backfill chunk',
    );
    if (summary.next === null) return;
    await deps.db
      .update(jobs)
      .set({ payload: { ...payload, afterUserId: summary.next } })
      .where(eq(jobs.id, job.id));
    return { outcome: 'retry', delayMs: 0 };
  };
}
