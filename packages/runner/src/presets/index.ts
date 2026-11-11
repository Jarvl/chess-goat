import type { Preset } from '@chess-goat/shared';
import type { RunnerConfig } from '../config.js';
import { claude } from './claude.js';
import { onPath, type HarnessPreset } from './common.js';
import { customPreset } from './custom.js';
import { codex, goose, opencode } from './others.js';

export { DEFAULT_PERSONA, onPath } from './common.js';
export type { HarnessPreset, TurnFiles } from './common.js';

const BY_NAME = { claude, codex, opencode, goose } as const;
const EXECUTABLE = { claude: 'claude', codex: 'codex', opencode: 'opencode', goose: 'goose' };

export function presetFor(config: RunnerConfig): HarnessPreset | 'lean' {
  if (config.preset === 'lean') return 'lean';
  if (config.preset === 'custom') {
    if (!config.custom) throw new Error('preset "custom" needs a "custom" section in the config');
    return customPreset(config.custom);
  }
  return BY_NAME[config.preset];
}

/** The first of claude, codex, opencode, goose found on PATH. Never lean or custom. */
export async function detectPreset(): Promise<Preset | null> {
  for (const name of Object.keys(EXECUTABLE) as (keyof typeof EXECUTABLE)[]) {
    if (onPath(EXECUTABLE[name])) return name;
  }
  return null;
}
