import type { EndReason, TurnKind } from '@chess-goat/shared';
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  matchNotes,
  runners,
  turnLeases,
  users,
  type GameRow,
  type RunnerRow,
  type TurnLeaseRow,
  type UserRow,
} from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { kindOf } from './playerKind';
import { pendingTurns, sameTurn, type PendingTurn } from './turns';

export const LEASE_DEFAULT_SECONDS = 300;
export const LEASE_MAX_SECONDS = 900;
export const RETRY_DELAYS_SECONDS = [60, 300, 1800] as const;
export const GAME_OVER_TTL_HOURS = 24;
export const TURN_CALL_BUDGET = 30;

/** Namespace of the two-key advisory lock `claimTurn` takes per owner. */
const CLAIM_LOCK = 0x7475726e; // 'turn'

/** Games ended by these offer no game-over turn: nothing was played out. */
const NO_GAME_OVER: ReadonlySet<EndReason> = new Set(['abort', 'timeout_abort', 'voided']);

export type ClaimedTurn = { lease: TurnLeaseRow; bot: UserRow };

/** Kinds read off the game state; the others exist only as lease rows. */
const isDerived = (kind: TurnKind): boolean =>
  kind === 'challenge' || kind === 'move' || kind === 'draw_offer';

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

/** Held by a runner and not yet run out. */
const isLeased = (row: TurnLeaseRow, now: Date): boolean =>
  row.runnerId !== null && row.leasedUntil !== null && row.leasedUntil > now;

/** Delay after failure `n` (1-based). */
const retryDelay = (failures: number): number =>
  RETRY_DELAYS_SECONDS[Math.min(failures, RETRY_DELAYS_SECONDS.length) - 1]!;

const turnEnded = (): DomainError =>
  new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });

const isPending = (row: TurnLeaseRow, pending: readonly PendingTurn[]): boolean =>
  pending.some((turn) => sameTurn(turn, row));

async function deleteLease(tx: DbOrTx, row: TurnLeaseRow): Promise<void> {
  await tx.delete(turnLeases).where(eq(turnLeases.id, row.id));
  // A game-over turn is the bot's last look at the game: its match notes go with it.
  if (row.kind === 'game_over' && row.gameId !== null) {
    await tx
      .delete(matchNotes)
      .where(and(eq(matchNotes.botId, row.botId), eq(matchNotes.gameId, row.gameId)));
  }
}

/**
 * Ends the row's lease, run out or given back: a still-pending derived turn counts a failure and
 * waits its retry delay; a resolved one and a game-over turn go; a practice turn is freed.
 */
async function endLease(
  tx: DbOrTx,
  row: TurnLeaseRow,
  stillPending: boolean,
  now: Date,
): Promise<TurnLeaseRow | null> {
  if (row.kind === 'practice') {
    const [freed] = await tx
      .update(turnLeases)
      .set({ runnerId: null, leasedUntil: null })
      .where(eq(turnLeases.id, row.id))
      .returning();
    return freed!;
  }
  if (!isDerived(row.kind) || !stillPending) {
    await deleteLease(tx, row);
    return null;
  }
  const failures = row.failures + 1;
  const [failed] = await tx
    .update(turnLeases)
    .set({
      runnerId: null,
      leasedUntil: null,
      failures,
      claimableAt: addSeconds(now, retryDelay(failures)),
    })
    .where(eq(turnLeases.id, row.id))
    .returning();
  return failed!;
}

/**
 * Brings this owner's lease rows up to date at `now` and returns those still standing: rows of
 * resolved turns go once no lease holds them, game-over and practice rows go when they expire,
 * and leases that ran out (or lost their runner) are ended as if released.
 */
async function settleLeases(
  tx: DbOrTx,
  rows: readonly TurnLeaseRow[],
  pending: readonly PendingTurn[],
  now: Date,
): Promise<TurnLeaseRow[]> {
  const kept: TurnLeaseRow[] = [];
  for (const row of rows) {
    const stillPending = isDerived(row.kind) && isPending(row, pending);
    if (row.expiresAt !== null && row.expiresAt <= now) {
      await deleteLease(tx, row);
      continue;
    }
    // A resolved turn still under lease stays, so its session can write notes until it ends.
    if (isLeased(row, now)) {
      kept.push(row);
      continue;
    }
    if (isDerived(row.kind) && !stillPending) {
      await deleteLease(tx, row);
      continue;
    }
    const settled = row.leasedUntil !== null ? await endLease(tx, row, stillPending, now) : row;
    if (settled) kept.push(settled);
  }
  return kept;
}

/** Live bots this runner serves: its owner's, narrowed to `runner.botIds` when set. */
async function servedBots(tx: DbOrTx, runner: RunnerRow): Promise<UserRow[]> {
  const conditions = [eq(users.ownerId, runner.ownerId), isNull(users.deletedAt)];
  if (runner.botIds !== null) conditions.push(inArray(users.id, runner.botIds));
  // Key share before any lease row: `setBotNotes` locks the bot, then the lease; claiming must
  // not hold a lease while it waits on a bot (inserting a lease checks its bot's key).
  return tx
    .select()
    .from(users)
    .where(and(...conditions))
    .orderBy(asc(users.id))
    .for('key share');
}

/** The most urgent claimable turn among the bots this runner serves, leased to it; null when none. */
export async function claimTurn(
  deps: Deps,
  runner: RunnerRow,
  opts: { leaseSeconds?: number; now?: Date },
): Promise<ClaimedTurn | null> {
  const now = opts.now ?? new Date();
  const seconds = Math.min(
    Math.max(Math.floor(opts.leaseSeconds ?? LEASE_DEFAULT_SECONDS), 1),
    LEASE_MAX_SECONDS,
  );
  const leasedUntil = addSeconds(now, seconds);
  return deps.db.transaction(async (tx) => {
    // One claim at a time per owner, so two runners can't both take a turn.
    const ownerKey = runner.ownerId % 2_147_483_647;
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK}::int, ${ownerKey}::int)`);
    // A runner revoked meanwhile claims nothing; the share lock holds off its revocation.
    const [live] = await tx
      .select({ id: runners.id })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .for('key share');
    if (!live) return null;
    const bots = await servedBots(tx, runner);
    if (bots.length === 0) return null;
    const botIds = bots.map((bot) => bot.id);

    const pending = await pendingTurns(tx, botIds);
    const rows = await settleLeases(
      tx,
      await tx
        .select()
        .from(turnLeases)
        .where(inArray(turnLeases.botId, botIds))
        .orderBy(asc(turnLeases.id))
        .for('update'),
      pending,
      now,
    );
    const free = (row: TurnLeaseRow) => !isLeased(row, now) && row.claimableAt <= now;

    // Practice jumps the queue; then derived turns, most urgent first; then game-over, oldest first.
    const pick = (): TurnLeaseRow | PendingTurn | undefined => {
      const practice = rows.find((row) => row.kind === 'practice' && free(row));
      if (practice) return practice;
      for (const turn of pending) {
        const row = rows.find((candidate) => sameTurn(candidate, turn));
        if (!row) return turn;
        if (free(row)) return row;
      }
      return rows.find((row) => row.kind === 'game_over' && free(row));
    };
    const chosen = pick();
    if (!chosen) return null;

    const bot = bots.find((candidate) => candidate.id === chosen.botId)!;
    const lease = {
      runnerId: runner.id,
      leasedUntil,
      callsUsed: 0,
      notesRevisionSeen: bot.botNotesRevision,
    };
    if ('id' in chosen) {
      const [updated] = await tx
        .update(turnLeases)
        .set(lease)
        .where(eq(turnLeases.id, chosen.id))
        .returning();
      return { lease: updated!, bot };
    }
    // No row yet; only a claim for this owner (held off by the lock) could insert one.
    const [inserted] = await tx
      .insert(turnLeases)
      .values({
        botId: chosen.botId,
        kind: chosen.kind,
        gameId: chosen.gameId,
        challengeId: chosen.challengeId,
        ply: chosen.ply,
        claimableAt: now,
        ...lease,
      })
      .returning();
    return { lease: inserted!, bot };
  });
}

/** Ends a lease early. A still-pending derived turn gets failures + 1 and the next retry delay. */
export async function releaseTurn(
  tx: DbOrTx,
  runnerId: number,
  leaseId: number,
  now: Date,
): Promise<void> {
  await tx.transaction(async (inner) => {
    const [row] = await inner
      .select()
      .from(turnLeases)
      .where(and(eq(turnLeases.id, leaseId), eq(turnLeases.runnerId, runnerId)))
      .for('update');
    // Not held by this runner (or gone): nothing to give back.
    if (!row) return;
    const stillPending =
      isDerived(row.kind) && isPending(row, await pendingTurns(inner, [row.botId]));
    await endLease(inner, row, stillPending, now);
  });
}

/**
 * The lease, if it is held, unexpired and its turn still pending (or, with `allowResolved`,
 * resolved but still under lease). Else throws reason 'turn_ended'.
 */
export async function requireLiveLease(
  tx: DbOrTx,
  leaseId: number,
  now: Date,
  opts: { allowResolved?: boolean } = {},
): Promise<TurnLeaseRow> {
  const [found] = await tx
    .select({ lease: turnLeases, deletedAt: users.deletedAt })
    .from(turnLeases)
    .innerJoin(users, eq(users.id, turnLeases.botId))
    .where(eq(turnLeases.id, leaseId));
  if (!found || found.deletedAt !== null) throw turnEnded();
  const { lease } = found;
  if (!isLeased(lease, now)) throw turnEnded();
  if (lease.expiresAt !== null && lease.expiresAt <= now) throw turnEnded();
  if (!opts.allowResolved && isDerived(lease.kind)) {
    if (!isPending(lease, await pendingTurns(tx, [lease.botId]))) throw turnEnded();
  }
  return lease;
}

/** Counts one tool call; throws 'turn_budget_spent' past TURN_CALL_BUDGET. */
export async function spendCall(tx: DbOrTx, leaseId: number): Promise<void> {
  const [spent] = await tx
    .update(turnLeases)
    .set({ callsUsed: sql`${turnLeases.callsUsed} + 1` })
    .where(and(eq(turnLeases.id, leaseId), lt(turnLeases.callsUsed, TURN_CALL_BUDGET)))
    .returning({ id: turnLeases.id });
  if (spent) return;
  const [exists] = await tx
    .select({ id: turnLeases.id })
    .from(turnLeases)
    .where(eq(turnLeases.id, leaseId));
  if (!exists) throw turnEnded();
  throw new DomainError('limit_exceeded', 'turn call budget spent', {
    reason: 'turn_budget_spent',
    limit: TURN_CALL_BUDGET,
  });
}

/** A game-over turn for each live bot that played `game`, unless it was aborted or voided. */
export async function offerGameOverTurns(tx: DbOrTx, game: GameRow, now: Date): Promise<void> {
  if (game.endReason === null || NO_GAME_OVER.has(game.endReason)) return;
  const players = await tx
    .select()
    .from(users)
    .where(and(inArray(users.id, [game.whiteId, game.blackId]), isNull(users.deletedAt)));
  const bots = players.filter((player) => kindOf(player) === 'bot');
  if (bots.length === 0) return;
  // A repeat (a second ending of the same game) must not fail the ending: the row stands.
  await tx
    .insert(turnLeases)
    .values(
      bots.map((bot) => ({
        botId: bot.id,
        kind: 'game_over' as const,
        gameId: game.id,
        ply: null,
        claimableAt: now,
        expiresAt: addSeconds(now, GAME_OVER_TTL_HOURS * 3600),
      })),
    )
    .onConflictDoNothing();
}

/** Failure counts for live turns, for list_bots: botId → count of turns with failures > 0. */
export async function failingTurns(
  tx: DbOrTx,
  botIds: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (botIds.length === 0) return counts;
  const [rows, pending] = await Promise.all([
    tx
      .select()
      .from(turnLeases)
      .where(and(inArray(turnLeases.botId, [...botIds]), gt(turnLeases.failures, 0))),
    pendingTurns(tx, botIds),
  ]);
  for (const row of rows) {
    // Only derived turns fail; one that has since resolved no longer counts.
    if (!isPending(row, pending)) continue;
    counts.set(row.botId, (counts.get(row.botId) ?? 0) + 1);
  }
  return counts;
}
