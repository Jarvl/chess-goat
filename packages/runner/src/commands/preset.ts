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
  warnMissingHarness,
  type Context,
} from './context.js';
import { autostartDetail, enableAndStart } from './link.js';
import { PRESET_OPTIONS, chooseHarness, warnLeanEnv, warnUnverified } from './presetChoice.js';

export async function preset(ctx: Context, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    'preset',
    args,
    { ...PRESET_OPTIONS, 'no-autostart': { type: 'boolean' }, 'no-start': { type: 'boolean' } },
    1,
  );
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
  const { lean: _l, custom: _c, needsPreset: _n, ...rest } = config;
  void _l;
  void _c;
  void _n;
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
  await warnMissingHarness(ctx, next);

  const wasRunning = ctx.daemon.status(data).running;
  if (wasRunning && !(await ctx.daemon.stop(data))) {
    throw new Fail(
      'Preset saved, but the running runner would not stop; stop it, then run goat-runner start.',
    );
  }

  if (config.needsPreset) {
    // Finish what `link` skipped: autostart, then the process.
    const done = await enableAndStart(ctx, data, {
      noAutostart: values['no-autostart'] === true,
      noStart: values['no-start'] === true,
    });
    const detail = autostartDetail(done.autostart, done.detail);
    if (done.autostart) warnLeanEnv(ctx, values['lean-api-key-env']);
    if (values.json) {
      sayJson(ctx, {
        preset: name,
        restarted: false,
        started: done.started,
        autostart: done.autostart,
        autostart_detail: detail,
      });
    } else {
      say(ctx, `The preset is now ${name}.`);
      say(
        ctx,
        done.started
          ? 'The background runner is running.'
          : 'The background runner is not running.',
      );
      say(ctx, `Start at login: ${done.autostart ? 'on' : 'off'} (${detail}).`);
    }
    if (values['no-start'] !== true && !done.started) {
      throw new Fail(
        'Preset saved, but the background runner did not start; run goat-runner run to see why.',
      );
    }
    return 0;
  }

  // Start at login may already be on: the variable matters to it as well.
  if (values['lean-api-key-env'] !== undefined) {
    let on = false;
    try {
      on = await ctx.autostart.enabled(ctx.autostartPlan());
    } catch {
      // no plan on this machine: not on
    }
    if (on) warnLeanEnv(ctx, values['lean-api-key-env']);
  }

  let restarted = false;
  if (wasRunning) {
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
