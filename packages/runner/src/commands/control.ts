import { readConfig, removeConfig, type RunnerConfig } from '../config.js';
import { readLogTail } from '../log.js';
import { parse } from './args.js';
import {
  Fail,
  NOT_LINKED,
  UsageError,
  pathsOf,
  say,
  sayJson,
  sentence,
  warn,
  type Context,
} from './context.js';

/** The config, or null when unlinked; a broken file is a one-sentence failure (its own message). */
function load(dir: string): RunnerConfig | null {
  try {
    return readConfig(dir);
  } catch (e) {
    throw new Fail((e as Error).message);
  }
}

export async function start(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('start', args, {}, 0);
  const { config, data } = pathsOf(ctx);
  if (!load(config)) throw new Fail(NOT_LINKED);
  const before = ctx.daemon.status(data);
  const after = before.running
    ? before
    : await ctx.daemon.start({ cliPath: ctx.cliPath, dataDir: data });
  if (!after.running) {
    throw new Fail(
      'The background runner did not start; run goat-runner run to see why, or goat-runner logs.',
    );
  }
  if (values.json) sayJson(ctx, { started: !before.running, running: true, pid: after.pid });
  else say(ctx, before.running ? 'The runner is already running.' : 'The runner started.');
  return 0;
}

export async function stop(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('stop', args, {}, 0);
  const { data } = pathsOf(ctx);
  const before = ctx.daemon.status(data);
  if (!before.running) {
    if (values.json) sayJson(ctx, { stopped: false, running: false });
    else say(ctx, 'The runner was not running.');
    return 0;
  }
  if (!(await ctx.daemon.stop(data))) {
    throw new Fail(`Could not stop the runner (process ${before.pid}); end that process yourself.`);
  }
  if (values.json) sayJson(ctx, { stopped: true, running: false });
  else say(ctx, 'The runner stopped.');
  return 0;
}

export async function status(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('status', args, {}, 0);
  const { config: configDir, data } = pathsOf(ctx);
  const config = load(configDir);
  const daemon = ctx.daemon.status(data);
  let autostart = false;
  try {
    autostart = await ctx.autostart.enabled(ctx.autostartPlan());
  } catch {
    // no plan on this machine (GOAT_RUNNER_HOME on Windows): not enabled
  }
  // Chosen field by field: the credential must never be in this object.
  const out = {
    linked: config !== null,
    runner_id: config?.runnerId ?? null,
    server: config?.server ?? null,
    preset: config?.preset ?? null,
    running: daemon.running,
    pid: daemon.pid,
    since: daemon.since,
    autostart,
  };
  if (values.json) {
    sayJson(ctx, out);
    return 0;
  }
  if (config) {
    say(ctx, `Linked: runner ${config.runnerId} on ${config.server} (${config.preset})`);
  } else say(ctx, 'Linked: no');
  say(
    ctx,
    daemon.running ? `Running: yes (process ${daemon.pid}, since ${daemon.since})` : 'Running: no',
  );
  say(ctx, `Start at login: ${autostart ? 'on' : 'off'}`);
  return 0;
}

export async function logs(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('logs', args, { n: { type: 'string', short: 'n' } }, 0);
  const n = values.n === undefined ? 50 : Number(values.n);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError('-n needs a whole number of lines', 'logs');
  const { data } = pathsOf(ctx);
  const text = readLogTail(data, n);
  if (values.json) sayJson(ctx, { lines: text === '' ? [] : text.split('\n') });
  else say(ctx, text === '' ? 'No log yet.' : text);
  return 0;
}

export async function autostart(ctx: Context, args: string[]): Promise<number> {
  const { values, positionals } = parse('autostart', args, {}, 1);
  const word = positionals[0];
  if (word !== 'on' && word !== 'off') throw new UsageError('say on or off', 'autostart');
  const { config } = pathsOf(ctx);
  // launchd would start the runner at once, and an unlinked one only fails and restarts.
  if (word === 'on' && !load(config)) throw new Fail(NOT_LINKED);
  let res: { ok: boolean; detail: string };
  try {
    res = await ctx.autostart.set(word === 'on', ctx.autostartPlan());
  } catch (e) {
    res = { ok: false, detail: (e as Error).message };
  }
  if (!res.ok)
    throw new Fail(`Start at login could not be turned ${word}: ${sentence(res.detail)}`);
  if (values.json) sayJson(ctx, { autostart: word === 'on', detail: res.detail });
  else say(ctx, word === 'on' ? `Start at login is on: ${res.detail}.` : 'Start at login is off.');
  return 0;
}

export async function unlink(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('unlink', args, {}, 0);
  const { config, data } = pathsOf(ctx);
  const wasRunning = ctx.daemon.status(data).running;
  if (wasRunning && !(await ctx.daemon.stop(data))) {
    throw new Fail(
      'Could not stop the runner, so nothing was removed; end that process yourself, then unlink again.',
    );
  }
  let removed = false;
  let detail: string;
  try {
    const res = await ctx.autostart.set(false, ctx.autostartPlan());
    removed = res.ok;
    detail = res.detail;
  } catch (e) {
    detail = (e as Error).message;
  }
  if (!removed) warn(ctx, `Start at login could not be removed: ${sentence(detail)}`);
  try {
    removeConfig(config);
  } catch {
    throw new Fail('Could not remove the stored link; delete the config file yourself.');
  }
  if (values.json) {
    sayJson(ctx, { unlinked: true, stopped: wasRunning, autostart_removed: removed });
  } else {
    say(ctx, 'Unlinked: the runner is stopped and the stored link is gone.');
    say(
      ctx,
      'The server still lists this runner until it is revoked with revoke_runner or in the Mini App.',
    );
  }
  return 0;
}
