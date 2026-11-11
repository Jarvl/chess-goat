import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutostartPlan } from '../../src/autostart.js';
import { writeConfig } from '../../src/config.js';
import { createClient } from '../../src/client.js';
import type { Context } from '../../src/commands/context.js';
import type { DaemonStatus } from '../../src/daemon.js';

export type Fake = {
  ctx: Context;
  home: string;
  out: () => string;
  err: () => string;
  /** Every fake side effect, in order. */
  calls: string[];
  daemon: { running: boolean; since: string };
  signals: { fire(): void };
  cleanup(): void;
};

const plan = (startsNow: boolean): AutostartPlan => ({
  platform: 'linux',
  files: [],
  enable: [],
  disable: [],
  remove: [],
  afterRemove: [],
  startsNow,
  describe: 'a fake unit',
});

/** A Context that touches nothing real: temp folders, recorded calls, fake autostart and daemon. */
export function fakeContext(
  opts: {
    platform?: Context['platform'];
    startsNow?: boolean;
    autostartOk?: boolean;
    detect?: 'claude' | null;
    /** The command missingHarness reports as not on PATH. */
    missing?: string | null;
    runLoop?: Context['runLoop'];
    claim?: Context['daemon']['claim'];
    stopWorks?: boolean;
    /** Turning autostart off also ends the running daemon (launchd's bootout). */
    autostartOffKills?: boolean;
    /** Starting the daemon does not work. */
    startFails?: boolean;
    /** The runner ends by itself after this many `sleep` calls (a login job being turned off). */
    diesAfterSleeps?: number;
    writeConfig?: Context['writeConfig'];
  } = {},
): Fake {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-cli-'));
  let out = '';
  let err = '';
  const calls: string[] = [];
  // Far in the future so a running daemon is newer than any config the test wrote.
  const daemon = { running: false, since: '2999-01-01T00:00:00.000Z' };
  let handler: (() => void) | undefined;
  let sleeps = 0;
  const status = (): DaemonStatus =>
    daemon.running
      ? { running: true, pid: 4242, since: daemon.since }
      : { running: false, pid: null, since: null };
  const ctx: Context = {
    env: {},
    platform: opts.platform ?? 'linux',
    version: '9.9.9',
    hostname: 'test-host',
    cliPath: '/fake/cli.js',
    writeConfig: opts.writeConfig ?? writeConfig,
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    paths: () => ({ config: path.join(home, 'config'), data: path.join(home, 'data') }),
    autostartPlan: () => plan(opts.startsNow ?? false),
    autostart: {
      async set(on) {
        calls.push(`autostart ${on ? 'on' : 'off'}`);
        if (!on && opts.autostartOffKills) daemon.running = false;
        const ok = opts.autostartOk ?? true;
        return { ok, detail: ok ? 'a fake unit' : 'systemctl is not available on this machine' };
      },
      enabled: async () => false,
    },
    daemon: {
      status,
      async start() {
        calls.push('start');
        if (opts.startFails) return status();
        daemon.running = true;
        return status();
      },
      async stop() {
        calls.push('stop');
        if (opts.stopWorks === false) return false;
        daemon.running = false;
        return true;
      },
      claim:
        opts.claim ??
        (() => {
          calls.push('claim pid');
          return { release: () => void calls.push('release pid') };
        }),
    },
    createClient,
    runLoop: opts.runLoop ?? (async () => 'stopped'),
    detectPreset: async () => opts.detect ?? null,
    missingHarness: async () => opts.missing ?? null,
    consoleLogger: () => ({ info: () => {}, warn: () => {} }),
    fileLogger: () => ({ info: () => {}, warn: (l) => void calls.push(`log: ${l}`) }),
    onSignal(h) {
      handler = h;
      return () => void (handler = undefined);
    },
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as Context['exit'],
    // A startsNow plan's runner "appears" while we wait for it.
    async sleep() {
      sleeps += 1;
      if (opts.diesAfterSleeps !== undefined) {
        if (sleeps >= opts.diesAfterSleeps) daemon.running = false;
      } else if (opts.startsNow) daemon.running = true;
    },
  };
  return {
    ctx,
    home,
    out: () => out,
    err: () => err,
    calls,
    daemon,
    signals: { fire: () => handler?.() },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
