import type { Colour, EndReason } from '@chess-goat/shared';

/** Telegram lets a bot delete its own messages for 48 hours; an hour short leaves room for queue lag. */
export const DM_DELETE_WINDOW_MS = 47 * 60 * 60 * 1000;

/**
 * A game DM sent this recently is edited to the newer text rather than replaced, so two events
 * close together (a move, then a draw offer) buzz the phone once.
 */
export const DM_COALESCE_MS = 10_000;

export function canDelete(sentAt: Date, now: Date): boolean {
  return now.getTime() - sentAt.getTime() < DM_DELETE_WINDOW_MS;
}

const SILENT_ENDINGS: ReadonlySet<EndReason> = new Set(['abort', 'timeout_abort', 'voided']);

/** DM notifications spec §4.2: the result DM goes to each player who did not end the game. */
export function resultRecipients(endReason: EndReason, endedBy: Colour | null): Colour[] {
  if (SILENT_ENDINGS.has(endReason)) return [];
  if (endedBy === null) return ['white', 'black'];
  return [endedBy === 'white' ? 'black' : 'white'];
}
