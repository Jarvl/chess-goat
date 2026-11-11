import type { Preset } from '@chess-goat/shared';
import type { RunnerConfig } from '../config.js';
import { claude } from './claude.js';
import { type HarnessPreset } from './common.js';
import { customPreset } from './custom.js';
import { codex, goose, opencode } from './others.js';

export { DEFAULT_PERSONA, onPath } from './common.js';
export { UNVERIFIED_NOTES } from './others.js';
export type { HarnessPreset, TurnFiles } from './common.js';

const BY_NAME = { claude, codex, opencode, goose } as const;

export function presetFor(config: RunnerConfig): HarnessPreset | 'lean' {
  if (config.preset === 'lean') return 'lean';
  if (config.preset === 'custom') {
    if (!config.custom) throw new Error('preset "custom" needs a "custom" section in the config');
    return customPreset(config.custom);
  }
  return BY_NAME[config.preset];
}

/**
 * The command of a harness preset that is not on PATH, or null (found, or lean, which has no
 * command). Never runs it, and never throws: a broken preset is reported elsewhere.
 */
export async function missingHarness(config: RunnerConfig): Promise<string | null> {
  if (config.preset === 'lean') return null;
  try {
    const preset = presetFor(config);
    if (preset === 'lean') return null;
    const command = config.preset === 'custom' ? config.custom!.command : config.preset;
    return (await preset.detect()) ? null : command;
  } catch {
    return null;
  }
}

/**
 * Only claude is ever auto-selected. codex, opencode, goose, lean and custom are chosen by an
 * explicit `--preset`, never by what happens to be installed.
 */
export async function detectPreset(): Promise<Preset | null> {
  return (await claude.detect()) ? 'claude' : null;
}
