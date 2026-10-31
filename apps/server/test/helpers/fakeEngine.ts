import type { EngineLevel } from '@chess-goat/shared';
import type { BestMove, Engine } from '../../src/engine/engine';

export type EngineCall = { fen: string; level: EngineLevel; deadlineMs: number };

export type FakeEngineOptions = {
  /** Replies in order; the last one repeats once the list runs out. */
  replies?: BestMove[];
  /** Thrown instead of replying, for the crash and timeout paths. */
  fail?: Error;
  available?: boolean;
  /**
   * Runs before the reply is returned, so a test can change the world while the engine is
   * "thinking" — the game ending between the job being enqueued and the reply arriving is exactly
   * the race spec §9's `(none)` row describes.
   */
  onCall?: (call: EngineCall) => Promise<void> | void;
};

export type FakeEngine = Engine & { calls: EngineCall[] };

export function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const replies = options.replies ?? [{ uci: 'e7e5' }];
  const calls: EngineCall[] = [];
  return {
    calls,
    async bestMove(fen, level, deadlineMs) {
      calls.push({ fen, level, deadlineMs });
      await options.onCall?.({ fen, level, deadlineMs });
      if (options.fail) throw options.fail;
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
    async probe() {
      return { available: options.available ?? true, version: 'fake 1' };
    },
  };
}
