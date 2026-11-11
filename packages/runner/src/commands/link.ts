import { PRESETS, type Preset } from '@chess-goat/shared';
import { NetworkError, ServerError } from '../client.js';
import { ConfigSchema, writeConfig, type RunnerConfig } from '../config.js';
import { cleanText } from '../http.js';
import { UNVERIFIED_NOTES } from '../presets/index.js';
import { parse } from './args.js';
import {
  Fail,
  UsageError,
  pathsOf,
  say,
  sayJson,
  sentence,
  warn,
  type Context,
} from './context.js';

const GATED = ['codex', 'opencode', 'goose'] as const;
const WAIT_STARTS_MS = 5000;

type Flags = {
  'allow-unverified'?: boolean;
  'lean-base-url'?: string;
  'lean-model'?: string;
  'lean-api-key-env'?: string;
  'custom-command'?: string;
  'custom-arg'?: string[];
};

const isGated = (p: Preset): p is (typeof GATED)[number] =>
  (GATED as readonly string[]).includes(p);

/**
 * Refusals that depend only on the chosen preset, and the lean/custom config section its flags
 * make. Runs before redeeming when the flag names the preset, after it when the server did (then
 * `burned`: the code is used up).
 */
function checkPreset(
  preset: Preset,
  f: Flags,
  burned: boolean,
): Pick<RunnerConfig, 'lean' | 'custom'> {
  const refuse = (message: string): never => {
    const retry = burned ? ' The link code is used up: ask your agent for a new one.' : '';
    throw new UsageError(`${message}${retry}`, 'link');
  };
  if (isGated(preset) && !f['allow-unverified']) {
    const notes = UNVERIFIED_NOTES[preset].map((n) => `  - ${n}`).join('\n');
    return refuse(
      `the ${preset} preset has never been run for real. Known gaps:\n${notes}\nPass --allow-unverified to use it anyway.`,
    );
  }
  if (preset === 'lean') {
    if (!f['lean-base-url'] || !f['lean-model']) {
      return refuse('--preset lean needs --lean-base-url and --lean-model.');
    }
    return {
      lean: {
        baseUrl: f['lean-base-url'],
        model: f['lean-model'],
        ...(f['lean-api-key-env'] ? { apiKeyEnv: f['lean-api-key-env'] } : {}),
      },
    };
  }
  if (preset === 'custom') {
    if (!f['custom-command']) return refuse('--preset custom needs --custom-command.');
    return { custom: { command: f['custom-command'], args: f['custom-arg'] ?? [] } };
  }
  return {};
}

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
      'allow-unverified': { type: 'boolean' },
      'lean-base-url': { type: 'string' },
      'lean-model': { type: 'string' },
      'lean-api-key-env': { type: 'string' },
      'custom-command': { type: 'string' },
      'custom-arg': { type: 'string', multiple: true },
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
    const extra = checkPreset(flagPreset, values, false);
    const probe = ConfigSchema.safeParse({
      ...baseConfig(server.data, 'x', 1, flagPreset),
      ...extra,
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

  const preset = flagPreset ?? linked.preset ?? (await ctx.detectPreset());
  if (!preset) {
    throw new UsageError(
      `no preset chosen and none found; pass --preset with one of ${PRESETS.join(', ')}. The link code is used up: ask your agent for a new one.`,
      'link',
    );
  }
  const extra = checkPreset(preset, values, !flagPreset);
  if (preset === 'claude' || isGated(preset)) {
    warn(ctx, `Warning: the ${preset} preset is unverified; it may not behave as intended.`);
  }

  // A re-link: the running daemon holds the old credential, so it goes before the config does.
  let oldStuck = false;
  if (ctx.daemon.status(dataDir).running) oldStuck = !(await ctx.daemon.stop(dataDir));
  writeConfig(configDir, {
    ...baseConfig(server.data, linked.credential, linked.runner_id, preset),
    ...extra,
  });

  let autostart = false;
  let detail = 'skipped (--no-autostart)';
  let startsNow = false;
  if (!values['no-autostart']) {
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
  if (!values['no-start'] && !oldStuck) {
    if (startsNow) started = await waitRunning(ctx, dataDir);
    else started = (await ctx.daemon.start({ cliPath: ctx.cliPath, dataDir })).running;
  }

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
