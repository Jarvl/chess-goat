import { PRESETS, type Preset } from '@chess-goat/shared';
import { ConfigSchema, readConfig } from '../config.js';
import { parse } from './args.js';
import {
  Fail,
  NOT_LINKED,
  UsageError,
  pathsOf,
  say,
  sayJson,
  sentence,
  type Context,
} from './context.js';
import { PRESET_OPTIONS, chooseHarness, warnUnverified } from './presetChoice.js';

export async function preset(ctx: Context, args: string[]): Promise<number> {
  const { values, positionals } = parse('preset', args, PRESET_OPTIONS, 1);
  const name = positionals[0]!;
  if (!(PRESETS as readonly string[]).includes(name)) {
    throw new UsageError(`unknown preset; choose one of ${PRESETS.join(', ')}`, 'preset');
  }
  const { config: configDir, data } = pathsOf(ctx);
  let config;
  try {
    config = readConfig(configDir);
  } catch (e) {
    throw new Fail((e as Error).message);
  }
  if (!config) throw new Fail(NOT_LINKED);

  const choice = chooseHarness(name as Preset, values);
  if (!choice.ok) throw new UsageError(`${choice.reason}. ${choice.hint}`, 'preset');
  // The old sections go: a stale lean or custom block must not outlive its preset.
  const { lean: _l, custom: _c, ...rest } = config;
  void _l;
  void _c;
  const next = { ...rest, preset: name as Preset, ...choice.extra };
  const probe = ConfigSchema.safeParse(next);
  if (!probe.success) {
    throw new Fail(
      `Cannot use that preset: ${sentence(probe.error.issues[0]?.message ?? 'bad settings')}`,
    );
  }
  warnUnverified(ctx, name as Preset);
  try {
    ctx.writeConfig(configDir, next);
  } catch (e) {
    throw new Fail(`Could not save the preset: ${sentence((e as Error).message)}`);
  }

  let restarted = false;
  if (ctx.daemon.status(data).running) {
    if (!(await ctx.daemon.stop(data))) {
      throw new Fail(
        'Preset saved, but the running runner would not stop; stop it, then run goat-runner start.',
      );
    }
    if (!(await ctx.daemon.start({ cliPath: ctx.cliPath, dataDir: data })).running) {
      throw new Fail(
        'Preset saved, but the runner did not restart; run goat-runner run to see why.',
      );
    }
    restarted = true;
  }
  if (values.json) sayJson(ctx, { preset: name, restarted });
  else {
    say(ctx, `The preset is now ${name}.`);
    say(
      ctx,
      restarted ? 'The background runner was restarted.' : 'Run goat-runner start to start it.',
    );
  }
  return 0;
}
