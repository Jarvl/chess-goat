import {
  decodeStartParam,
  PREFS_DEFAULTS,
  type LaunchResponse,
  type Prefs,
  type StartParam,
} from '@chess-goat/shared';
import { signal } from '@preact/signals';
import { setYourMoveCount } from './yourMove';

export type Session = {
  user: LaunchResponse['user'];
  bot: LaunchResponse['bot'];
  /** What the direct link opened; null for a profile launch. */
  launchedFrom: StartParam | null;
};

export const session = signal<Session | null>(null);
export const prefs = signal<Prefs>(PREFS_DEFAULTS);
/** `serverTime − Date.now()` at the last response; clocks tick from the server's view of time. */
export const serverOffsetMs = signal(0);

export function noteServerTime(iso: string): void {
  const parsed = Date.parse(iso);
  if (Number.isFinite(parsed)) serverOffsetMs.value = parsed - Date.now();
}

export function serverNow(): Date {
  return new Date(Date.now() + serverOffsetMs.value);
}

export function applyLaunch(response: LaunchResponse, startParam: string | null): void {
  session.value = {
    user: response.user,
    bot: response.bot,
    launchedFrom: decodeStartParam(startParam),
  };
  prefs.value = response.prefs;
  setYourMoveCount(response.yourMove);
  noteServerTime(response.serverTime);
}
