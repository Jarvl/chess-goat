import type { TimePerMove } from './protocol/enums';

/** Reminders exist only for controls of eight hours or more (spec §5.7, §7.3). */
export const REMINDER_MIN_TIME_PER_MOVE = 28800;

export const REMINDER_FRACTION = 0.1;

export function deadlineAfterMove(now: Date, timePerMove: TimePerMove): Date | null {
  if (timePerMove === null) return null;
  return new Date(now.getTime() + timePerMove * 1000);
}

export function reminderAt(
  deadline: Date | null,
  timePerMove: TimePerMove,
  dmAllowed: boolean,
): Date | null {
  if (!deadline || timePerMove === null || !dmAllowed) return null;
  if (timePerMove < REMINDER_MIN_TIME_PER_MOVE) return null;
  return new Date(deadline.getTime() - timePerMove * REMINDER_FRACTION * 1000);
}

/** Coarse remaining time for DM copy, e.g. `23 h left`. Never negative. */
export function formatTimeLeft(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${seconds} s`;
}

/** A bot counts as "active now" when it was last active within this long (5 minutes). */
export const BOT_ACTIVE_NOW_MS = 300_000;

/** Compact elapsed time for "last active … ago": `3d`, `5h`, `12m`. Never negative. */
export function compactDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes >= 1_440) return `${Math.floor(minutes / 1_440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

/** Ticking clock display for the app. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}:${mm}`;
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}
