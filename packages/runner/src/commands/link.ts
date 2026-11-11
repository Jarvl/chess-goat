import { PRESETS, type Preset } from '@chess-goat/shared';
import { NetworkError, ServerError } from '../client.js';
import { ConfigSchema } from '../config.js';
import { cleanText } from '../http.js';
import { parse } from './args.js';
import { PRESET_OPTIONS, chooseHarness, warnUnverified } from './presetChoice.js';
import { Fail, UsageError, pathsOf, say, sayJson, sentence, type Context } from './context.js';

const WAIT_STARTS_MS = 5000;

const baseConfig = (server: string, credential: string, runnerId: number, preset: Preset) => ({
  server,
  credential,
  runnerId,
  preset,
  concurrency: 2,
  leaseSeconds: 300,
});

function linkFailure(e: unknown): Fail {
  if (e instanceof ServerError) return new Fail(sentence(e.message));
  if (e instanceof NetworkError) {
    return new Fail(`${sentence(e.message)} Check the server address and your connection.`);
  }
  return new Fail(sentence(cleanText(e instanceof Error ? e.message : 'link failed', 300)));
}

async function waitRunning(ctx: Context, dataDir: string): Promise<boolean> {
  const deadline = Date.now() + WAIT_STARTS_MS;
  while (!ctx.daemon.status(dataDir).running) {
    if (Date.now() >= deadline) return false;
    await ctx.sleep(100);
  }
  return true;
}

/** What a linked runner needs once a harness is accepted: autostart first, then the process. */
export async function enableAndStart(
  ctx: Context,
  dataDir: string,
  opts: { noAutostart: boolean; noStart: boolean },
): Promise<{ started: boolean; autostart: boolean; detail: string }> {
  let autostart = false;
  let detail = 'skipped (--no-autostart)';
  let startsNow = false;
  if (!opts.noAutostart) {
    try {
      const plan = ctx.autostartPlan();
      const res = await ctx.autostart.set(true, plan);
      autostart = res.ok;
      detail = res.detail;
      startsNow = res.ok && plan.startsNow;
    } catch (e) {
      detail = (e as Error).message;
    }
  }
  let started = false;
  if (!opts.noStart) {
    if (startsNow) started = await waitRunning(ctx, dataDir);
    else started = (await ctx.daemon.start({ cliPath: ctx.cliPath, dataDir })).running;
  }
  return { started, autostart, detail };
}

export async function link(ctx: Context, args: string[]): Promise<number> {
  const { values, positionals } = parse(
    'link',
    args,
    {
      server: { type: 'string' },
      preset: { type: 'string' },
      label: { type: 'string' },
      'no-autostart': { type: 'boolean' },
      'no-start': { type: 'boolean' },
      ...PRESET_OPTIONS,
    },
    1,
  );
  const code = positionals[0]!;
  if (!values.server) throw new UsageError('--server is required', 'link');
  let flagPreset: Preset | undefined;
  if (values.preset !== undefined) {
    if (!(PRESETS as readonly string[]).includes(values.preset)) {
      throw new UsageError(`unknown preset; choose one of ${PRESETS.join(', ')}`, 'link');
    }
    flagPreset = values.preset as Preset;
  }

  const server = ConfigSchema.shape.server.safeParse(values.server);
  if (!server.success) {
    throw new Fail(
      `Cannot link: ${sentence(server.error.issues[0]?.message ?? 'bad server address')}`,
    );
  }
  const { config: configDir, data: dataDir } = pathsOf(ctx);
  // Everything that can be refused without the server is, before the code is used up.
  if (flagPreset) {
    const choice = chooseHarness(flagPreset, values);
    if (!choice.ok) throw new UsageError(`${choice.reason}. ${choice.hint}`, 'link');
    const probe = ConfigSchema.safeParse({
      ...baseConfig(server.data, 'x', 1, flagPreset),
      ...choice.extra,
    });
    if (!probe.success) {
      throw new Fail(`Cannot link: ${sentence(probe.error.issues[0]?.message ?? 'bad settings')}`);
    }
  }

  const client = ctx.createClient({ server: server.data, userAgent: `goat-runner/${ctx.version}` });
  let linked;
  try {
    linked = await client.link({
      code,
      label: cleanText(values.label ?? ctx.hostname, 64) || undefined,
      ...(flagPreset ? { harness: flagPreset } : {}),
    });
  } catch (e) {
    throw linkFailure(e); // nothing local has changed
  }

  // The credential now exists on the server: whatever happens next, it is saved.
  const found = flagPreset ?? linked.preset ?? (await ctx.detectPreset());
  const choice = found ? chooseHarness(found, values) : null;
  const accepted = found !== null && choice?.ok === true;
  const preset: Preset = accepted ? found : 'claude'; // a placeholder when refused
  const save = (): void => {
    try {
      ctx.writeConfig(configDir, {
        ...baseConfig(server.data, linked.credential, linked.runner_id, preset),
        ...(choice?.ok ? choice.extra : {}),
        ...(accepted ? {} : { needsPreset: true as const }),
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const why = `${err.code ? `${err.code}: ` : ''}${cleanText(err.message ?? 'unknown error', 150)}`;
      throw new Fail(
        `Linked as runner ${linked.runner_id} but could not save the link (${why}). The link code is used up; ask your agent for a new one.`,
      );
    }
  };
  save();
  if (accepted) warnUnverified(ctx, preset);

  // A re-link: the old daemon holds the old credential; the new config is safe by now.
  let oldStuck = false;
  if (ctx.daemon.status(dataDir).running) oldStuck = !(await ctx.daemon.stop(dataDir));

  if (!accepted) {
    if (oldStuck) {
      throw new UsageError(
        `Linked as runner ${linked.runner_id}, but the previous runner would not stop; run goat-runner stop.\nChoose the harness with: goat-runner preset <name>`,
        'preset',
      );
    }
    const why = choice && !choice.ok ? `${choice.reason}` : 'no preset was chosen, stored or found';
    const hint = choice && !choice.ok ? ` ${choice.hint}` : ` Choose one of ${PRESETS.join(', ')}.`;
    if (values.json) {
      sayJson(ctx, {
        linked: true,
        runner_id: linked.runner_id,
        preset,
        started: false,
        autostart: false,
        autostart_detail: 'skipped (a preset is needed)',
        needs_preset: true,
      });
    }
    throw new UsageError(
      `Linked as runner ${linked.runner_id}, but ${why}. Nothing is running yet.${hint}\nChoose the harness with: goat-runner preset <name>`,
      'preset',
    );
  }

  const { started, autostart, detail } = await enableAndStart(ctx, dataDir, {
    noAutostart: values['no-autostart'] === true,
    noStart: values['no-start'] === true || oldStuck,
  });

  const result = {
    linked: true,
    runner_id: linked.runner_id,
    preset,
    started,
    autostart,
    autostart_detail: cleanText(detail, 300),
  };
  if (values.json) sayJson(ctx, result);
  else {
    say(ctx, `Linked runner ${linked.runner_id} (${preset}).`);
    say(
      ctx,
      started ? 'The background runner is running.' : 'The background runner is not running.',
    );
    say(
      ctx,
      autostart
        ? `Start at login: on (${result.autostart_detail}).`
        : `Start at login: off (${result.autostart_detail}).`,
    );
  }
  if (oldStuck) {
    throw new Fail(
      'Linked, but the old background runner would not stop; stop it yourself, then run goat-runner start.',
    );
  }
  if (!values['no-start'] && !started) {
    throw new Fail(
      'Linked, but the background runner did not start; run goat-runner run to see why.',
    );
  }
  return 0;
}
