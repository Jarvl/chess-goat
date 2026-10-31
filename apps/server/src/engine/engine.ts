import type { EngineLevel } from '@chess-goat/shared';

/** A move in UCI notation, or `none` when the engine reports the position is terminal. */
export type BestMove = { uci: string } | { none: true };

/**
 * The seam between the server and Stockfish (spec §6.2). Everything above it — jobs, domain, API —
 * depends only on this, which is what keeps the test suite free of the binary (spec §11).
 */
export type Engine = {
  bestMove(fen: string, level: EngineLevel, deadlineMs: number): Promise<BestMove>;
  probe(): Promise<{ available: boolean; version?: string }>;
};
