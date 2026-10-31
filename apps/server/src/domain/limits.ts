import {
  REMINDER_FRACTION,
  REMINDER_MIN_TIME_PER_MOVE,
  type TimePerMove,
} from '@chess-goat/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges } from '../db/schema';

/** Spec §7.8. */
export const MAX_PENDING_CHALLENGES = 3;

async function count(tx: DbOrTx, query: Promise<{ n: number }[]>): Promise<number> {
  void tx;
  const [row] = await query;
  return row?.n ?? 0;
}

export function countPendingChallenges(
  tx: DbOrTx,
  groupId: number,
  challengerId: number,
): Promise<number> {
  return count(
    tx,
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(challenges)
      .where(
        and(
          eq(challenges.groupId, groupId),
          eq(challenges.challengerId, challengerId),
          eq(challenges.status, 'pending'),
        ),
      ),
  );
}

/** `deadline_at − 0.1·T` expressed against the database clock; null when no reminder applies (spec §7.3). */
export function reminderExpression(timePerMove: TimePerMove, wantsDms: boolean): SQL | null {
  if (timePerMove === null || timePerMove < REMINDER_MIN_TIME_PER_MOVE || !wantsDms) return null;
  return sql`now() + make_interval(secs => ${timePerMove * (1 - REMINDER_FRACTION)})`;
}

export function deadlineExpression(timePerMove: TimePerMove): SQL | null {
  if (timePerMove === null) return null;
  return sql`now() + make_interval(secs => ${timePerMove})`;
}
