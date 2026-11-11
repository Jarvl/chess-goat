import type { Preset } from '@chess-goat/shared';
import type { AutostartPlan, RunFn } from '../autostart.js';
import type { Client, ClientOptions } from '../client.js';
import type { DaemonStatus } from '../daemon.js';
import type { LoopDeps, Logger } from '../loop.js';
import type { Platform } from '../paths.js';
import { cleanLine } from '../log.js';

/** One sentence on stderr, exit 1. */
export class Fail extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = 'Fail';
  }
}

/** Exit 2: the message, then the usage of `command` (null: the top-level one). */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command: string | null,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Everything a command touches outside its own arguments, so tests can fake the machine. */
export type Context = {
  env: NodeJS.ProcessEnv;
  platform: Platform;
  version: string;
  hostname: string;
  /** The built cli.js and the node that runs it, for the background process. */
  cliPath: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Throws (a relative GOAT_RUNNER_HOME), hence a function. */
  paths(): { config: string; data: string };
  autostartPlan(): AutostartPlan;
  autostart: {
    set(
      on: boolean,
      plan: AutostartPlan,
      opts?: { run?: RunFn },
    ): Promise<{ ok: boolean; detail: string }>;
    enabled(plan: AutostartPlan): Promise<boolean>;
  };
  daemon: {
    status(dataDir: string): DaemonStatus;
    start(opts: { cliPath: string; dataDir: string }): Promise<DaemonStatus>;
    stop(dataDir: string): Promise<boolean>;
    claim(dataDir: string): { release(): void };
  };
  createClient(opts: ClientOptions): Client;
  runLoop(deps: LoopDeps, signal: AbortSignal): Promise<'stopped' | 'revoked'>;
  detectPreset(): Promise<Preset | null>;
  consoleLogger(): Logger;
  fileLogger(dataDir: string): Logger;
  /** Registers for SIGINT and SIGTERM; returns the remover. */
  onSignal(handler: () => void): () => void;
  /** Ends the process at once (a second signal). */
  exit(code: number): never;
  sleep(ms: number): Promise<void>;
};

// Everything from the server or the config goes through cleanLine before it reaches a terminal.
export const say = (ctx: Context, line: string) => ctx.stdout(`${cleanLine(line)}\n`);
export const warn = (ctx: Context, line: string) => ctx.stderr(`${cleanLine(line)}\n`);
export const sayJson = (ctx: Context, value: unknown) => ctx.stdout(`${JSON.stringify(value)}\n`);

export const NOT_LINKED =
  'Not linked. Ask your agent to call link_runner and run the command it gives.';

/** The folders, or the one-sentence failure (a relative GOAT_RUNNER_HOME). */
export function pathsOf(ctx: Context): { config: string; data: string } {
  try {
    return ctx.paths();
  } catch (e) {
    throw new Fail(`${(e as Error).message}; fix or unset it.`);
  }
}

export const sentence = (text: string) => {
  const t = cleanLine(text).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
