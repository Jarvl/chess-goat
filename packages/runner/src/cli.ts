import os from 'node:os';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { autostartEnabled, autostartPlan, setAutostart } from './autostart.js';
import { createClient } from './client.js';
import { main } from './commands/index.js';
import type { Context } from './commands/context.js';
import { writeConfig } from './config.js';
import { consoleLogger, fileLogger } from './log.js';
import { claimPidFile, daemonStatus, startDaemon, stopDaemon } from './daemon.js';
import { runLoop } from './loop.js';
import { defaultPaths, type Platform } from './paths.js';
import { detectPreset, missingHarness } from './presets/index.js';

// Replaced by tsup at build time with package.json's version.
declare const __VERSION__: string;

function realContext(): Context {
  const cliPath = realpathSync(fileURLToPath(import.meta.url));
  const platform = process.platform as Platform;
  return {
    env: process.env,
    platform,
    version: __VERSION__,
    hostname: os.hostname(),
    cliPath,
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    writeConfig,
    paths: defaultPaths,
    autostartPlan: () =>
      autostartPlan(platform, {
        nodePath: process.execPath,
        cliPath,
        home: os.homedir(),
        uid: process.getuid?.(),
        env: process.env,
      }),
    autostart: { set: setAutostart, enabled: autostartEnabled },
    daemon: {
      status: (dir) => daemonStatus(dir),
      start: (o) => startDaemon(o),
      stop: (dir) => stopDaemon(dir),
      claim: (dir) => claimPidFile(dir),
    },
    createClient,
    runLoop,
    detectPreset,
    missingHarness,
    consoleLogger,
    fileLogger: (dir) => fileLogger(dir),
    onSignal(handler) {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
    exit: (code) => process.exit(code),
    sleep: (ms) => delay(ms),
  };
}

const code = await main(process.argv.slice(2), realContext());
process.exitCode = code;
// A leaked handle must not keep a stopped runner alive; unref'd, so a clean exit is not delayed.
setTimeout(() => process.exit(code), 1000).unref();
