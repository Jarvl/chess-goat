import { sideToMove } from '@chess-goat/shared';
import { and, asc, eq, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { games } from '../db/schema';
import { expireChallenges } from '../domain/challenges';
import type { Deps } from '../domain/deps';
import { applyTimeout, finishGame } from '../domain/games';
import { STALE_BOT_GAME_DAYS } from '../domain/limits';
import { enqueue } from '../jobs/queue';
import { pollBackoffMs } from '../jobs/worker';
import { mixFilter } from '../domain/gameMix';

/** Spec §7.3 forfeit scanner: rows are the state; the transaction re-checks each deadline against now(). */
export async function forfeitOverdueGames(deps: Deps, limit = 100): Promise<number> {
  const finished = await deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(games)
      .where(and(eq(games.status, 'active'), lte(games.deadlineAt, sql`now()`)))
      .orderBy(asc(games.deadlineAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    const now = await dbNow(tx);
    const publicIds: string[] = [];
    for (const game of due) {
      if (game.status !== 'active' || !game.deadlineAt || game.deadlineAt.getTime() > now.getTime())
        continue;
      await applyTimeout(tx, game, now);
      publicIds.push(game.publicId);
    }
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
  return finished.length;
}

/** Clockless bot-vs-bot games idle for STALE_BOT_GAME_DAYS are aborted: no result, no rating change. */
export async function abortStaleBotGames(deps: Deps, limit = 100): Promise<number> {
  const finished = await deps.db.transaction(async (tx) => {
    // Same expression and predicate as the partial index games_bot_vs_bot_stale. The constants are
    // SQL literals, not bind parameters, so a generic prepared plan can still prove the predicate.
    const lastActivity = sql`coalesce(${games.lastMoveAt}, ${games.startedAt})`;
    const stale = await tx
      .select()
      .from(games)
      .where(
        and(
          sql`${games.status} = 'active'`,
          mixFilter.botsOnly(games.botPlayers),
          isNull(games.timePerMove),
          lt(lastActivity, sql`now() - make_interval(days => ${STALE_BOT_GAME_DAYS})`),
        ),
      )
      .orderBy(asc(lastActivity))
      .limit(limit)
      .for('update', { skipLocked: true });
    const now = await dbNow(tx);
    const publicIds: string[] = [];
    for (const game of stale) {
      await finishGame(tx, game, { result: '*', endReason: 'abort' }, now);
      publicIds.push(game.publicId);
    }
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
  return finished.length;
}

/** Spec §7.3 reminder scanner: one DM per turn, then the column is cleared. */
export async function sendDueReminders(deps: Deps, limit = 100): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(games)
      .where(
        and(
          eq(games.status, 'active'),
          isNotNull(games.reminderAt),
          lte(games.reminderAt, sql`now()`),
        ),
      )
      .orderBy(asc(games.reminderAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const game of due) {
      const userId = sideToMove(game.fen) === 'white' ? game.whiteId : game.blackId;
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId, template: 'reminder', gameId: game.id },
        dedupKey: `dm:${userId}:g:${game.publicId}`,
        mergePayload: true,
      });
      await tx.update(games).set({ reminderAt: null }).where(eq(games.id, game.id));
    }
    return due.length;
  });
}

export async function runScannersOnce(deps: Deps): Promise<{
  forfeits: number;
  reminders: number;
  expiries: number;
  staleBotGames: number;
}> {
  const forfeits = await forfeitOverdueGames(deps);
  const reminders = await sendDueReminders(deps);
  const expiries = await expireChallenges(deps);
  const staleBotGames = await abortStaleBotGames(deps);
  return { forfeits, reminders, expiries, staleBotGames };
}

/** The `clock` role: every 5 s by default (spec §7.3). Errors are logged and the loop continues. */
export function startScanners(
  deps: Deps,
  options: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 5_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let failures = 0;
  const tick = async (): Promise<void> => {
    inFlight = runScannersOnce(deps)
      .then((counts) => {
        failures = 0;
        if (counts.forfeits || counts.reminders || counts.expiries || counts.staleBotGames)
          deps.log.info(counts, 'scanners applied transitions');
      })
      .catch((error: unknown) => {
        failures += 1;
        deps.log.error({ err: error, failures }, 'scanner pass failed');
      });
    await inFlight;
    if (!stopped) timer = setTimeout(() => void tick(), pollBackoffMs(intervalMs, failures));
  };
  timer = setTimeout(() => void tick(), 0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
