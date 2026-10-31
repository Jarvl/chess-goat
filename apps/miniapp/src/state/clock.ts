import { formatClock, t, type TimePerMove } from '@chess-goat/shared';

/** Milliseconds until the deadline as seen from the server's clock; never negative. */
export function remainingMs(deadlineAt: string | null, now: Date): number | null {
  if (!deadlineAt) return null;
  return Math.max(0, Date.parse(deadlineAt) - now.getTime());
}

/** The side to move counts down; the waiting side shows the full budget it will get (PRD §7.4). */
export function clockLabel(
  remaining: number | null,
  timePerMove: TimePerMove,
  ticking: boolean,
): string {
  if (timePerMove === null) return t('app.game.no_clock');
  if (ticking && remaining !== null) return formatClock(remaining);
  return formatClock(timePerMove * 1000);
}

export function isUrgent(remaining: number | null, timePerMove: TimePerMove): boolean {
  if (remaining === null || timePerMove === null) return false;
  return remaining <= Math.max(timePerMove * 100, 3_600_000);
}
