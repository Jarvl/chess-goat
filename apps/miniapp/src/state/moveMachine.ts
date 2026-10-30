import type { EngineLevel, MoveConfirmations } from '@group-chess/shared';

export type PendingMove = {
  uci: string;
  expectedPly: number;
  clientMoveId: string;
  /** The premove tree sent with the move (conditional premoves spec): `''` for none. */
  premoveTree: string;
};

export type MoveState =
  | { kind: 'idle' }
  /** Dropped and shown on the board, waiting for Confirm move or Cancel (move confirmations spec). */
  | { kind: 'pendingConfirm'; move: PendingMove }
  | { kind: 'sending'; move: PendingMove; attempt: number }
  | { kind: 'retry'; move: PendingMove; attempt: number; nextAt: number };

export type MoveEvent =
  | { type: 'drop'; uci: string; expectedPly: number; clientMoveId?: string }
  /** Confirm move, carrying the encoded premove tree built on top of the move. */
  | { type: 'confirm'; premoveTree: string }
  /** A different move played from the position before the waiting one takes its place. */
  | { type: 'replace'; uci: string }
  | { type: 'cancel' }
  | { type: 'sent' }
  /** 409 or 422: reload the state and snap back without a message (spec §6.3). */
  | { type: 'rejected' }
  /** 413: the tree made the request too big. The move waits again, nothing reloads. */
  | { type: 'tooBig' }
  | { type: 'networkError'; now: number }
  | { type: 'retryNow' }
  | { type: 'tick'; now: number };

export type MoveEffect =
  | { type: 'send'; move: PendingMove }
  | { type: 'restore' }
  | { type: 'reload' }
  | { type: 'telemetryRetry' };

const RETRY_MAX_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s (spec §6.3). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Sixteen characters from `[a-z0-9]`, well inside the API's `^[A-Za-z0-9_-]{8,64}$`. */
export function newClientMoveId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 16; i += 1)
    id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  return id;
}

/** Whether a dropped move waits for Confirm move: the player's setting against this kind of game. */
export function needsConfirmation(
  setting: MoveConfirmations,
  game: { engineLevel: EngineLevel | null },
): boolean {
  switch (setting) {
    case 'always':
      return true;
    case 'people':
      return game.engineLevel === null;
    case 'never':
      return false;
  }
}

/** The move state machine of spec §6.3 as a pure reducer; the screen runs the effects. */
export function reduceMove(
  state: MoveState,
  event: MoveEvent,
  options: { confirm: boolean } = { confirm: false },
): { state: MoveState; effects: MoveEffect[] } {
  const same = { state, effects: [] as MoveEffect[] };
  switch (state.kind) {
    case 'idle': {
      if (event.type !== 'drop') return same;
      const move: PendingMove = {
        uci: event.uci,
        expectedPly: event.expectedPly,
        clientMoveId: event.clientMoveId ?? newClientMoveId(),
        premoveTree: '',
      };
      if (options.confirm) return { state: { kind: 'pendingConfirm', move }, effects: [] };
      return { state: { kind: 'sending', move, attempt: 1 }, effects: [{ type: 'send', move }] };
    }
    case 'pendingConfirm': {
      if (event.type === 'confirm') {
        const move = { ...state.move, premoveTree: event.premoveTree };
        return {
          state: { kind: 'sending', move, attempt: 1 },
          effects: [{ type: 'send', move }],
        };
      }
      if (event.type === 'replace') {
        // A new id: the server must never take the replacement for a retry of the old move.
        const move = { ...state.move, uci: event.uci, clientMoveId: newClientMoveId() };
        return { state: { kind: 'pendingConfirm', move }, effects: [] };
      }
      if (event.type === 'cancel')
        return { state: { kind: 'idle' }, effects: [{ type: 'restore' }] };
      return same;
    }
    case 'sending': {
      if (event.type === 'sent') return { state: { kind: 'idle' }, effects: [] };
      if (event.type === 'tooBig')
        return { state: { kind: 'pendingConfirm', move: state.move }, effects: [] };
      if (event.type === 'rejected') {
        return { state: { kind: 'idle' }, effects: [{ type: 'restore' }, { type: 'reload' }] };
      }
      if (event.type === 'networkError') {
        return {
          state: {
            kind: 'retry',
            move: state.move,
            attempt: state.attempt,
            nextAt: event.now + retryDelayMs(state.attempt),
          },
          effects: state.attempt === 1 ? [{ type: 'telemetryRetry' }] : [],
        };
      }
      return same;
    }
    case 'retry': {
      const due = event.type === 'retryNow' || (event.type === 'tick' && event.now >= state.nextAt);
      if (!due) return same;
      return {
        state: { kind: 'sending', move: state.move, attempt: state.attempt + 1 },
        effects: [{ type: 'send', move: state.move }],
      };
    }
  }
}
