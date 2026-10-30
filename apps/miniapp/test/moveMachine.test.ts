import { describe, expect, it } from 'vitest';
import {
  needsConfirmation,
  newClientMoveId,
  reduceMove,
  retryDelayMs,
  type MoveEvent,
  type MoveState,
} from '../src/state/moveMachine';

const drop: MoveEvent = { type: 'drop', uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' };
const run = (events: MoveEvent[], from: MoveState = { kind: 'idle' }, confirm = false) => {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const out = reduceMove(state, event, { confirm });
    state = out.state;
    effects.push(...out.effects.map((effect) => effect.type));
  }
  return { state, effects };
};

describe('reduceMove', () => {
  it('sends a dropped move immediately', () => {
    const { state, effects } = run([drop]);
    expect(state).toEqual({
      kind: 'sending',
      move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001', premoveTree: '' },
      attempt: 1,
    });
    expect(effects).toEqual(['send']);
  });

  it('returns to idle and restores the position on a stale rejection', () => {
    const sending = run([drop]).state;
    const { state, effects } = run([{ type: 'rejected' }], sending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore', 'reload']);
  });

  it('keeps the client move id and backs off across network retries', () => {
    const sending = run([drop]).state;
    const first = run([{ type: 'networkError', now: 1_000 }], sending);
    expect(first.state).toEqual({
      kind: 'retry',
      move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001', premoveTree: '' },
      attempt: 1,
      nextAt: 2_000,
    });
    expect(first.effects).toEqual(['telemetryRetry']);
    const early = run([{ type: 'tick', now: 1_999 }], first.state);
    expect(early.state.kind).toBe('retry');
    expect(early.effects).toEqual([]);
    const second = run([{ type: 'tick', now: 2_000 }], first.state);
    expect(second.state).toMatchObject({
      kind: 'sending',
      attempt: 2,
      move: { clientMoveId: 'm-0000000001' },
    });
    expect(second.effects).toEqual(['send']);
    const third = run([{ type: 'networkError', now: 5_000 }], second.state);
    expect(third.state).toMatchObject({ kind: 'retry', attempt: 2, nextAt: 7_000 });
    expect(third.effects).toEqual([]);
    const manual = run([{ type: 'retryNow' }], third.state);
    expect(manual.state).toMatchObject({ kind: 'sending', attempt: 3 });
    expect(manual.effects).toEqual(['send']);
  });

  it('caps the retry delay at thirty seconds', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(5)).toBe(16_000);
    expect(retryDelayMs(6)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(30_000);
  });

  it('ignores a drop while a move is in flight and a stray answer while idle', () => {
    const sending = run([drop]).state;
    const ignored = run([{ ...drop, uci: 'd2d4' }], sending);
    expect(ignored.state).toBe(sending);
    expect(ignored.effects).toEqual([]);
    expect(run([{ type: 'sent' }]).state).toEqual({ kind: 'idle' });
  });

  it('makes client move ids that satisfy the API pattern', () => {
    const id = newClientMoveId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newClientMoveId()).not.toBe(id);
    expect(newClientMoveId(() => 0)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newClientMoveId(() => 1)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('holds a dropped move for confirmation, then sends it exactly once', () => {
    const move = { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001', premoveTree: '' };
    const pending = run([drop], { kind: 'idle' }, true);
    expect(pending.state).toEqual({ kind: 'pendingConfirm', move });
    expect(pending.effects).toEqual([]);
    const confirmed = run([{ type: 'confirm', premoveTree: '' }], pending.state);
    expect(confirmed.state).toEqual({ kind: 'sending', move, attempt: 1 });
    expect(confirmed.effects).toEqual(['send']);
    // A second Confirm before the screen catches up sends nothing more.
    expect(run([{ type: 'confirm', premoveTree: '' }], confirmed.state).effects).toEqual([]);
  });

  it('copies the premove tree given at Confirm into the move it sends', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const out = reduceMove(pending, { type: 'confirm', premoveTree: 'AQAB' });
    expect(out.state).toMatchObject({ kind: 'sending', move: { premoveTree: 'AQAB' } });
    expect(out.effects).toEqual([
      {
        type: 'send',
        move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001', premoveTree: 'AQAB' },
      },
    ]);
  });

  it('swaps the waiting move on replace, with a new client move id and no effects', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const out = reduceMove(pending, { type: 'replace', uci: 'd2d4' });
    expect(out.effects).toEqual([]);
    expect(out.state).toMatchObject({
      kind: 'pendingConfirm',
      move: { uci: 'd2d4', expectedPly: 0, premoveTree: '' },
    });
    const id = (out.state as { move: { clientMoveId: string } }).move.clientMoveId;
    expect(id).not.toBe('m-0000000001');
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // Only a waiting move can be replaced.
    const sending = run([drop]).state;
    expect(reduceMove(sending, { type: 'replace', uci: 'd2d4' }).state).toBe(sending);
    expect(reduceMove({ kind: 'idle' }, { type: 'replace', uci: 'd2d4' }).state).toEqual({
      kind: 'idle',
    });
  });

  it('takes a confirmed move back to waiting when it was too big to send', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const sending = reduceMove(pending, { type: 'confirm', premoveTree: 'AQAB' }).state;
    const out = reduceMove(sending, { type: 'tooBig' });
    expect(out.state).toMatchObject({ kind: 'pendingConfirm', move: { uci: 'e2e4' } });
    expect(out.effects).toEqual([]);
  });

  it('puts the piece back on cancel and sends nothing', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const { state, effects } = run([{ type: 'cancel' }], pending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore']);
  });

  it('ignores another drop, network answers and ticks while a move waits', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const stray: MoveEvent[] = [
      { ...drop, uci: 'd2d4' },
      { type: 'sent' },
      { type: 'networkError', now: 1 },
      { type: 'tick', now: 99_999 },
      { type: 'retryNow' },
    ];
    for (const event of stray) {
      const out = run([event], pending);
      expect(out.state).toBe(pending);
      expect(out.effects).toEqual([]);
    }
  });

  it('ignores a cancel once the move is on its way', () => {
    const sending = run([drop]).state;
    const out = run([{ type: 'cancel' }], sending);
    expect(out.state).toBe(sending);
    expect(out.effects).toEqual([]);
  });
});

describe('needsConfirmation', () => {
  it.each([
    ['always', null, true],
    ['always', 'casual', true],
    ['people', null, true],
    ['people', 'casual', false],
    ['never', null, false],
    ['never', 'casual', false],
  ] as const)('%s against engine level %s → %s', (setting, engineLevel, expected) => {
    expect(needsConfirmation(setting, { engineLevel })).toBe(expected);
  });
});
