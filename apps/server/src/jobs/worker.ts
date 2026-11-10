import { and, eq, getTableColumns, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, type JobRow } from '../db/schema';
import type { Logger } from '../logger';
import type { JobHandlers, JobKind, JobResult } from './types';

export type WorkerOptions = {
  db: Db;
  log: Logger;
  handlers: JobHandlers;
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  pollMs?: number;
  /** Called when a job is failed permanently (explicit `fail` or exhausted attempts). */
  onFailed?: (job: JobRow, error: string) => void;
};

type LeasedJob = JobRow & { runAtText: string };

type Outcome = JobResult | { outcome: 'error'; error: string };

/** `min(5 s · 2^attempts, 1 h)` where `attempts` counts failures so far. */
export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** attempts, 3600);
}

/** Pollers back off while the database is unavailable; doubles per failure, capped at a minute. */
export function pollBackoffMs(baseMs: number, consecutiveFailures: number): number {
  return Math.min(baseMs * 2 ** consecutiveFailures, 60_000);
}

/** How long an unknown job kind waits for a worker that knows it (rolling deploys, split roles). */
const UNKNOWN_KIND_RETRY_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: WorkerOptions) {}

  /** One poll: lease due jobs and run them in order. Returns how many were processed. */
  async runOnce(): Promise<number> {
    const leased = await this.lease();
    for (const job of leased) await this.process(job);
    return leased.length;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    let failures = 0;
    const tick = async (): Promise<void> => {
      this.inFlight = this.runOnce()
        .then(() => {
          failures = 0;
        })
        .catch((error: unknown) => {
          failures += 1;
          this.options.log.error({ err: error, failures }, 'job worker poll failed');
        });
      await this.inFlight;
      if (!this.stopped) {
        const delay = pollBackoffMs(this.options.pollMs ?? 1000, failures);
        this.timer = setTimeout(() => void tick(), delay);
      }
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  private async lease(): Promise<LeasedJob[]> {
    const { db, batchSize = 20, leaseSeconds = 60, workerId = 'worker' } = this.options;
    return db.transaction(async (tx) => {
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            isNull(jobs.doneAt),
            lte(jobs.runAt, sql`now()`),
            or(isNull(jobs.lockedUntil), sql`${jobs.lockedUntil} < now()`),
          ),
        )
        .orderBy(jobs.runAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(jobs)
        .set({
          lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          lockedBy: workerId,
        })
        .where(
          inArray(
            jobs.id,
            due.map((row) => row.id),
          ),
        )
        .returning({ ...getTableColumns(jobs), runAtText: sql<string>`${jobs.runAt}::text` });
    });
  }

  private async process(job: LeasedJob): Promise<void> {
    const { db, log, handlers } = this.options;
    const handler = handlers[job.kind as JobKind];
    let outcome: Outcome;
    if (!handler) {
      // Another worker (a newer deploy, or the process with this role) may know the kind.
      log.warn({ jobId: job.id, kind: job.kind }, 'no handler for job kind; leaving it pending');
      outcome = {
        outcome: 'retry',
        delayMs: UNKNOWN_KIND_RETRY_MS,
        error: `no handler for kind ${job.kind}`,
      };
    } else {
      try {
        outcome = (await handler({ job, db, log })) ?? { outcome: 'done' };
      } catch (error) {
        outcome = { outcome: 'error', error: errorMessage(error) };
      }
    }
    const unlock = { lockedUntil: null, lockedBy: null };
    switch (outcome.outcome) {
      case 'done': {
        // Only mark done if nobody moved run_at while we were working; otherwise it runs again.
        const updated = await db
          .update(jobs)
          .set({ doneAt: sql`now()`, ...unlock })
          .where(and(eq(jobs.id, job.id), sql`${jobs.runAt}::text = ${job.runAtText}`))
          .returning({ id: jobs.id });
        if (updated.length === 0) {
          await db.update(jobs).set(unlock).where(eq(jobs.id, job.id));
          log.debug(
            { jobId: job.id, kind: job.kind },
            'job re-enqueued while running; will run again',
          );
        }
        return;
      }
      case 'retry':
        await db
          .update(jobs)
          .set({
            runAt: sql`now() + make_interval(secs => ${outcome.delayMs / 1000})`,
            lastError: outcome.error ?? null,
            ...unlock,
          })
          .where(eq(jobs.id, job.id));
        return;
      case 'fail':
        await db
          .update(jobs)
          .set({ failedAt: sql`now()`, doneAt: sql`now()`, lastError: outcome.error, ...unlock })
          .where(eq(jobs.id, job.id));
        log.error({ jobId: job.id, kind: job.kind, error: outcome.error }, 'job failed');
        this.options.onFailed?.(job, outcome.error);
        return;
      case 'retry_attempt':
      case 'error': {
        const attempts = job.attempts + 1;
        if (attempts >= job.maxAttempts) {
          await db
            .update(jobs)
            .set({
              attempts,
              failedAt: sql`now()`,
              doneAt: sql`now()`,
              lastError: outcome.error,
              ...unlock,
            })
            .where(eq(jobs.id, job.id));
          log.error(
            { jobId: job.id, kind: job.kind, error: outcome.error, attempts },
            'job exhausted',
          );
          this.options.onFailed?.(job, outcome.error);
        } else {
          await db
            .update(jobs)
            .set({
              attempts,
              runAt: sql`now() + make_interval(secs => ${
                outcome.outcome === 'retry_attempt'
                  ? outcome.delayMs / 1000
                  : backoffSeconds(job.attempts)
              })`,
              lastError: outcome.error,
              ...unlock,
            })
            .where(eq(jobs.id, job.id));
          log.warn(
            { jobId: job.id, kind: job.kind, error: outcome.error, attempts },
            'job failed; retrying',
          );
        }
      }
    }
  }
}
