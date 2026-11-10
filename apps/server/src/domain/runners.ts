import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PRESETS, type Preset } from '@chess-goat/shared';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { runnerLinkCodes, runners, users, type RunnerRow, type UserRow } from '../db/schema';
import { requireOwnBot } from './bots';
import { DomainError, isDomainError } from './errors';
import { freeRunnerLeases, lockOwnerTurns } from './turnLeases';
import { lockLiveHumanOwner } from './users';

export { PRESETS };
export type { Preset };

export const RUNNER_PREFIX = 'cgrun_';
export const MAX_RUNNERS_PER_OWNER = 5;
export const MAX_LINK_CODES_PER_OWNER = 5;
export const LINK_CODE_TTL_SECONDS = 600;
export const RUNNER_ONLINE_SECONDS = 90;

/** 32 random bytes in base64url, unpadded. */
const CREDENTIAL_BODY_LENGTH = 43;
const BODY_PATTERN = /^[A-Za-z0-9_-]+$/;
/** No look-alikes (I, L, O, U, 0, 1). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_LABEL_LENGTH = 64;
const MAX_HARNESS_LENGTH = 32;
const DEFAULT_LABEL = 'Runner';
const TOUCH_INTERVAL_MS = 60_000;

const hash = (text: string): Buffer => createHash('sha256').update(text).digest();
const seconds = (n: number): number => n * 1000;
const length = (text: string): number => [...text].length;

const newCode = (): string => {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

/** The 8 code characters of what a person typed, or null: case and the dash are not significant. */
const normaliseCode = (typed: string): string | null => {
  const kept = [...typed.toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join('');
  return kept.length === CODE_LENGTH ? kept : null;
};

const hashCode = (normalised: string): Buffer => hash(normalised);

/** Trimmed text of at most `max` code points, or undefined when blank or absent. */
function cleanText(value: string | undefined, max: number, what: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (length(text) > max) {
    throw new DomainError('validation', `${what} must be at most ${max} characters`);
  }
  return text;
}

/** A single-use code, valid for 10 minutes, that links a runner to the owner. */
export async function createLinkCode(
  tx: DbOrTx,
  ownerId: number,
  input: { label?: string; botIds?: number[]; preset?: Preset },
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  await lockLiveHumanOwner(tx, ownerId);
  const label = cleanText(input.label, MAX_LABEL_LENGTH, 'label');
  const botIds = input.botIds?.length ? [...new Set(input.botIds)] : undefined;
  for (const botId of botIds ?? []) await requireOwnBot(tx, ownerId, botId);

  await tx
    .delete(runnerLinkCodes)
    .where(and(eq(runnerLinkCodes.ownerId, ownerId), lte(runnerLinkCodes.expiresAt, now)));
  const [counted] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(runnerLinkCodes)
    .where(eq(runnerLinkCodes.ownerId, ownerId));
  if (counted!.count >= MAX_LINK_CODES_PER_OWNER) {
    throw new DomainError('limit_exceeded', 'too many unused link codes', {
      reason: 'too_many_link_codes',
      limit: MAX_LINK_CODES_PER_OWNER,
    });
  }

  const code = newCode();
  const expiresAt = new Date(now.getTime() + seconds(LINK_CODE_TTL_SECONDS));
  await tx.insert(runnerLinkCodes).values({
    codeHash: hashCode(code.replace('-', '')),
    ownerId,
    label: label ?? null,
    botIds: botIds ?? null,
    preset: input.preset ?? null,
    expiresAt,
  });
  return { code, expiresAt };
}

const linkCodeInvalid = () =>
  new DomainError('not_found', 'link code not found', { reason: 'link_code_invalid' });

/**
 * Spends a link code for a new runner and returns its credential, shown once. Run it in the
 * caller's transaction: the code row is locked, so two redemptions of one code yield one runner.
 */
export async function redeemLinkCode(
  tx: DbOrTx,
  code: string,
  input: { label?: string; harness?: string },
  now: Date,
): Promise<{ runner: RunnerRow; credential: string; preset: Preset | null }> {
  // Sliced first: nothing a person types is longer, and a huge input costs a scan.
  const normalised = normaliseCode(code.slice(0, 64));
  if (!normalised) throw linkCodeInvalid();
  const label = cleanText(input.label, MAX_LABEL_LENGTH, 'label');
  const harness = cleanText(input.harness, MAX_HARNESS_LENGTH, 'harness');

  const [row] = await tx
    .select()
    .from(runnerLinkCodes)
    .where(eq(runnerLinkCodes.codeHash, hashCode(normalised)))
    .for('update');
  if (!row) throw linkCodeInvalid();
  // Refused without deleting: a caller that rolls back on the refusal would undo the delete anyway,
  // and `createLinkCode` purges expired codes.
  if (row.expiresAt <= now) throw linkCodeInvalid();

  // A deleted or non-human owner looks like any other wrong code.
  try {
    await lockLiveHumanOwner(tx, row.ownerId);
  } catch (error) {
    if (isDomainError(error) && error.details.reason === 'not_a_human_owner') {
      throw linkCodeInvalid();
    }
    throw error;
  }
  const [counted] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(runners)
    .where(eq(runners.ownerId, row.ownerId));
  if (counted!.count >= MAX_RUNNERS_PER_OWNER) {
    throw new DomainError('limit_exceeded', 'too many runners', {
      reason: 'too_many_runners',
      limit: MAX_RUNNERS_PER_OWNER,
    });
  }

  await tx.delete(runnerLinkCodes).where(eq(runnerLinkCodes.codeHash, row.codeHash));
  const credential = RUNNER_PREFIX + randomBytes(32).toString('base64url');
  const [runner] = await tx
    .insert(runners)
    .values({
      ownerId: row.ownerId,
      label: label ?? row.label ?? DEFAULT_LABEL,
      harness: harness ?? null,
      botIds: row.botIds,
      credentialHash: hash(credential),
    })
    .returning();
  const preset = PRESETS.find((p) => p === row.preset) ?? null;
  return { runner: runner!, credential, preset };
}

/** Deletes every owner's link codes past their expiry, for the daily prune; returns how many. */
export async function deleteExpiredLinkCodes(tx: DbOrTx, now: Date): Promise<number> {
  const gone = await tx
    .delete(runnerLinkCodes)
    .where(lte(runnerLinkCodes.expiresAt, now))
    .returning({ ownerId: runnerLinkCodes.ownerId });
  return gone.length;
}

/** Whether the runner is still linked (not revoked, its owner not deleted). */
export async function runnerLinked(tx: DbOrTx, runnerId: number): Promise<boolean> {
  const [row] = await tx.select({ id: runners.id }).from(runners).where(eq(runners.id, runnerId));
  return row !== undefined;
}

/** Marks the runner seen at `now`, unconditionally (a claim poll calls it as it starts and ends). */
export async function touchRunner(tx: DbOrTx, runnerId: number, now: Date): Promise<void> {
  await tx.update(runners).set({ lastSeenAt: now }).where(eq(runners.id, runnerId));
}

/** The runner owning `presented` and its live owner, or null. Touches `lastSeenAt` at most once a minute. */
export async function resolveRunner(
  tx: DbOrTx,
  presented: string,
  now: Date,
): Promise<{ runner: RunnerRow; owner: UserRow } | null> {
  const credential = presented.trim();
  if (!credential.startsWith(RUNNER_PREFIX)) return null;
  const body = credential.slice(RUNNER_PREFIX.length);
  if (body.length !== CREDENTIAL_BODY_LENGTH || !BODY_PATTERN.test(body)) return null;

  const [row] = await tx
    .select({ runner: runners, owner: users })
    .from(runners)
    .innerJoin(users, eq(users.id, runners.ownerId))
    .where(and(eq(runners.credentialHash, hash(credential)), isNull(users.deletedAt)));
  if (!row) return null;

  const stale = new Date(now.getTime() - TOUCH_INTERVAL_MS);
  await tx
    .update(runners)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(runners.id, row.runner.id),
        or(isNull(runners.lastSeenAt), lt(runners.lastSeenAt, stale)),
      ),
    );
  return row;
}

export type RunnerView = {
  id: number;
  label: string;
  harness: string | null;
  bots: 'all' | string[];
  connected: boolean;
  lastSeenAt: Date | null;
};

const onlineCutoff = (now: Date): Date => new Date(now.getTime() - seconds(RUNNER_ONLINE_SECONDS));

export async function listRunners(tx: DbOrTx, ownerId: number, now: Date): Promise<RunnerView[]> {
  const rows = await tx
    .select()
    .from(runners)
    .where(eq(runners.ownerId, ownerId))
    .orderBy(asc(runners.createdAt), asc(runners.id));
  const scoped = [...new Set(rows.flatMap((r) => r.botIds ?? []))];
  const names = new Map<number, string>();
  if (scoped.length > 0) {
    const bots = await tx
      .select({ id: users.id, firstName: users.firstName })
      .from(users)
      .where(and(inArray(users.id, scoped), eq(users.ownerId, ownerId), isNull(users.deletedAt)));
    for (const bot of bots) names.set(bot.id, bot.firstName);
  }
  const cutoff = onlineCutoff(now);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    harness: r.harness,
    bots:
      r.botIds === null
        ? 'all'
        : r.botIds.flatMap((id) => names.get(id) ?? []).sort((a, b) => a.localeCompare(b)),
    connected: r.lastSeenAt !== null && r.lastSeenAt > cutoff,
    lastSeenAt: r.lastSeenAt,
  }));
}

/** Deletes the runner, first freeing the leases it holds with no failure counted. */
export async function revokeRunner(
  tx: DbOrTx,
  ownerId: number,
  runnerId: number,
  now: Date = new Date(),
): Promise<void> {
  // A claim's lock order: the owner's claim lock, the runner, then its lease rows.
  await lockOwnerTurns(tx, ownerId);
  const [runner] = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.ownerId, ownerId)))
    .for('update');
  if (!runner) {
    throw new DomainError('not_found', 'runner not found', { reason: 'runner_not_found' });
  }
  await freeRunnerLeases(tx, runnerId, now);
  await tx.delete(runners).where(eq(runners.id, runnerId));
}

/** Of `botIds`, those with a connected runner of their owner that serves them. */
export async function onlineBotIds(
  tx: DbOrTx,
  botIds: readonly number[],
  now: Date,
): Promise<Set<number>> {
  if (botIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(runners, eq(runners.ownerId, users.ownerId))
    .where(
      and(
        inArray(users.id, [...botIds]),
        gt(runners.lastSeenAt, onlineCutoff(now)),
        or(isNull(runners.botIds), sql`${users.id} = any(${runners.botIds})`),
      ),
    );
  return new Set(rows.map((r) => r.id));
}
