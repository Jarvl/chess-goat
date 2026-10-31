import type { EngineLevel } from '@chess-goat/shared';
import type { BestMove } from './engine';

export type UciOption = { name: string; value: string | number };

/**
 * Spec §7. The two Skill Level values and the two UCI_Elo values are chosen, not measured: this
 * project runs no calibration matches. `beginner` is the weakest setting Stockfish offers natively,
 * which is still well above a new player — see the spec's §14.
 */
const LEVELS: Record<EngineLevel, UciOption[]> = {
  beginner: [{ name: 'Skill Level', value: 0 }],
  casual: [{ name: 'Skill Level', value: 5 }],
  club: [
    { name: 'UCI_LimitStrength', value: 'true' },
    { name: 'UCI_Elo', value: 1600 },
  ],
  strong: [
    { name: 'UCI_LimitStrength', value: 'true' },
    { name: 'UCI_Elo', value: 2400 },
  ],
};

/**
 * A copy, and `readonly` besides: the table is per-process configuration shared by every game, and
 * a caller that mutated what it was handed would silently re-tune every level until the next deploy.
 */
export function optionsForLevel(level: EngineLevel): readonly UciOption[] {
  return LEVELS[level].map((option) => ({ ...option }));
}

/**
 * The option names the engine rejected, in the order they appear. Stockfish answers an unknown
 * `setoption` with `No such option: <name>` and then plays on at full strength, which is spec §13's
 * named risk: a renamed or missing `Skill Level`/`UCI_LimitStrength`/`UCI_Elo` would make two levels
 * play identically, and nothing else in the session output would say so.
 */
export function unsupportedOptions(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^No such option:\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Reads the `bestmove` line out of a UCI session. The promotion suffix must survive: without it the
 * arbiter rejects the move and the caller falls back to a random one (spec §9), which would turn a
 * parser bug into permanently bad play.
 */
export function parseBestMove(output: string): BestMove | null {
  let found: BestMove | null = null;
  for (const line of output.split('\n')) {
    const match = /^bestmove\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const token = match[1]!;
    found = token === '(none)' ? { none: true } : { uci: token };
  }
  return found;
}
