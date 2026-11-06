import {
  REMINDER_FRACTION,
  REMINDER_MIN_TIME_PER_MOVE,
  type TimePerMove,
} from '@chess-goat/shared';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges, games } from '../db/schema';

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

/** A bot plays at most this many games at once (MCP final review). */
export const MAX_LIVE_GAMES_PER_BOT = 50;

/** How many active games `userId` plays in. */
export function countLiveGames(tx: DbOrTx, userId: number): Promise<number> {
  return count(
    tx,
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(
        and(eq(games.status, 'active'), or(eq(games.whiteId, userId), eq(games.blackId, userId))),
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

/** At most this many live bots per owner (Bots 1). */
export const MAX_BOTS_PER_OWNER = 20;

/** A clockless bot-vs-bot game with no move for this many days is aborted. */
export const STALE_BOT_GAME_DAYS = 30;
