import { AlreadyRunningError } from '../daemon.js';
import { readConfig } from '../config.js';
import { cleanLine } from '../log.js';
import { presetFor } from '../presets/index.js';
import { parse } from './args.js';
import { Fail, NOT_LINKED, pathsOf, warn, type Context } from './context.js';

const REVOKED = 'This runner was revoked; link again.';

export async function run(ctx: Context, args: string[]): Promise<number> {
  const { values } = parse('run', args, { daemon: { type: 'boolean' } }, 0);
  const daemon = values.daemon === true;
  const { config: configDir, data } = pathsOf(ctx);

  let config;
  try {
    config = readConfig(configDir);
  } catch (e) {
    throw new Fail((e as Error).message);
  }
  if (!config) throw new Fail(NOT_LINKED);
  // Once, here, so a broken preset is one sentence now and not a failed turn later.
  try {
    presetFor(config);
  } catch (e) {
    throw new Fail(
      `The ${config.preset} preset is not usable: ${cleanLine((e as Error).message)}.`,
    );
  }

  let pid: { release(): void } | undefined;
  if (daemon) {
    try {
      pid = ctx.daemon.claim(data);
    } catch (e) {
      // Exit 0, so systemd and launchd do not restart a second runner in a loop.
      if (e instanceof AlreadyRunningError) return 0;
      throw e;
    }
  } else if (ctx.daemon.status(data).running) {
    throw new Fail('The runner is already running in the background; use goat-runner stop first.');
  }

  const log = daemon ? ctx.fileLogger(data) : ctx.consoleLogger();
  const abort = new AbortController();
  let signals = 0;
  const off = ctx.onSignal(() => {
    // A second signal means "now": the loop's own shutdown releases are what it interrupts.
    if (++signals > 1) {
      pid?.release();
      ctx.exit(1);
    }
    abort.abort();
  });
  try {
    const client = ctx.createClient({
      server: config.server,
      credential: config.credential,
      userAgent: `goat-runner/${ctx.version}`,
    });
    const result = await ctx.runLoop({ client, config, dataDir: data, log }, abort.signal);
    if (result === 'revoked') {
      if (daemon) log.warn(REVOKED);
      else warn(ctx, REVOKED);
      return 1;
    }
    return 0;
  } catch (e) {
    // The daemon has no terminal: its log is where the owner will look.
    if (daemon) log.warn(cleanLine((e as Error).message));
    throw e;
  } finally {
    off();
    pid?.release();
  }
}
