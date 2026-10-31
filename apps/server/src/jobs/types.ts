import type { Db } from '../db/client';
import type { JobRow } from '../db/schema';
import type { Logger } from '../logger';

/** Every side effect is one of these (spec §10). */
export const JOB_KINDS = [
  'send_challenge_card',
  'edit_card',
  'send_share_photo',
  'send_result_photo',
  'send_dm',
  'retire_dm',
  'send_welcome',
  'send_message',
  'delete_message',
  'engine_move',
  'lichess_import',
  'award_flair',
  'backfill_flair',
  'rebuild_ratings',
  'prune',
  'fetch_user_photo',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export type JobPayload = Record<string, unknown>;

export type JobResult =
  | { outcome: 'done' }
  /** Try again later without counting an attempt (Telegram 429, Lichess busy). */
  | { outcome: 'retry'; delayMs: number; error?: string }
  /** Counts an attempt and waits `delayMs` instead of the default backoff; fails when exhausted. */
  | { outcome: 'retry_attempt'; delayMs: number; error: string }
  | { outcome: 'fail'; error: string };

export type JobContext = { job: JobRow; db: Db; log: Logger };

export type JobHandler = (ctx: JobContext) => Promise<JobResult | void>;

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;
