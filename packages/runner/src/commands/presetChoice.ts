import type { Preset } from '@chess-goat/shared';
import type { RunnerConfig } from '../config.js';
import { UNVERIFIED_NOTES } from '../presets/index.js';
import { warn, type Context } from './context.js';

const GATED = ['codex', 'opencode', 'goose'] as const;

/** The parseArgs options `link` and `preset` share for choosing a harness. */
export const PRESET_OPTIONS = {
  'allow-unverified': { type: 'boolean' },
  'lean-base-url': { type: 'string' },
  'lean-model': { type: 'string' },
  'lean-api-key-env': { type: 'string' },
  'custom-command': { type: 'string' },
  'custom-arg': { type: 'string', multiple: true },
} as const;

export type Flags = {
  'allow-unverified'?: boolean;
  'lean-base-url'?: string;
  'lean-model'?: string;
  'lean-api-key-env'?: string;
  'custom-command'?: string;
  'custom-arg'?: string[];
};

export const isGated = (p: Preset): p is (typeof GATED)[number] =>
  (GATED as readonly string[]).includes(p);

export type Choice =
  | { ok: true; extra: Pick<RunnerConfig, 'lean' | 'custom'> }
  | { ok: false; reason: string; hint: string };

/**
 * Can `preset` be accepted with these flags, and which lean/custom section do they make?
 * Pure; `link` and `preset` share it so they can never disagree.
 */
export function chooseHarness(preset: Preset, f: Flags): Choice {
  const lean = ['lean-base-url', 'lean-model', 'lean-api-key-env'] as const;
  const custom = ['custom-command', 'custom-arg'] as const;
  for (const [section, names] of [
    ['lean', lean],
    ['custom', custom],
  ] as const) {
    const given = names.find((n) => f[n] !== undefined);
    if (given && preset !== section) {
      return {
        ok: false,
        reason: `--${given} belongs to the ${section} preset, not ${preset}`,
        hint: `Drop --${given}, or choose --preset ${section}.`,
      };
    }
  }
  if (isGated(preset) && !f['allow-unverified']) {
    return {
      ok: false,
      reason: `the ${preset} preset has never been run for real (known gaps: ${UNVERIFIED_NOTES[preset].join(' ')})`,
      hint: `Pass --allow-unverified to use it anyway.`,
    };
  }
  if (preset === 'lean') {
    if (!f['lean-base-url'] || !f['lean-model']) {
      return {
        ok: false,
        reason: 'the lean preset needs --lean-base-url and --lean-model',
        hint: 'Pass both (and optionally --lean-api-key-env).',
      };
    }
    return {
      ok: true,
      extra: {
        lean: {
          baseUrl: f['lean-base-url'],
          model: f['lean-model'],
          ...(f['lean-api-key-env'] ? { apiKeyEnv: f['lean-api-key-env'] } : {}),
        },
      },
    };
  }
  if (preset === 'custom') {
    if (!f['custom-command']) {
      return {
        ok: false,
        reason: 'the custom preset needs --custom-command',
        hint: 'Pass it, with --custom-arg=<arg> for each argument.',
      };
    }
    return {
      ok: true,
      extra: { custom: { command: f['custom-command'], args: f['custom-arg'] ?? [] } },
    };
  }
  return { ok: true, extra: {} };
}

export function warnUnverified(ctx: Context, preset: Preset): void {
  if (preset === 'claude' || isGated(preset)) {
    warn(ctx, `Warning: the ${preset} preset is unverified; it may not behave as intended.`);
  }
}
