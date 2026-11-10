import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { jobs } from '../db/schema';
import type { JobKind, JobPayload } from './types';

export type EnqueueInput = {
  kind: JobKind;
  payload?: JobPayload;
  /** A pending job with the same key is moved to the new run_at instead of duplicated. */
  dedupKey?: string;
  /**
   * With a dedup key: false leaves a pending job exactly as it is (its run_at, attempts and error)
   * instead of re-arming it, for causes that repeat without being new (a photo check per sighting).
   */
  rearm?: boolean;
  /**
   * With a dedup key: a re-armed pending job takes the new payload's keys over its own
   * (`payload || new`), so a job built from current state still carries every flag it was given.
   */
  mergePayload?: boolean;
  delaySeconds?: number;
  maxAttempts?: number;
};

export async function enqueue(tx: DbOrTx, input: EnqueueInput): Promise<void> {
  const runAt = input.delaySeconds
    ? sql`now() + make_interval(secs => ${input.delaySeconds})`
    : sql`now()`;
  const values = {
    kind: input.kind,
    payload: input.payload ?? {},
    dedupKey: input.dedupKey ?? null,
    runAt,
    maxAttempts: input.maxAttempts ?? 8,
  };
  if (!input.dedupKey) {
    await tx.insert(jobs).values(values);
    return;
  }
  if (input.rearm === false) {
    await tx
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({ target: jobs.dedupKey, where: sql`done_at is null` });
    return;
  }
  await tx
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupKey,
      targetWhere: sql`done_at is null`,
      // The re-arm is a new cause, so the attempt count starts over.
      set: {
        runAt: sql`excluded.run_at`,
        attempts: 0,
        lastError: null,
        ...(input.mergePayload ? { payload: sql`${jobs.payload} || excluded.payload` } : {}),
      },
    });
}
