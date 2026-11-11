import spawn from 'cross-spawn';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './session.js';

export type DaemonStatus = { running: boolean; pid: number | null; since: string | null };
type PidFile = { pid: number; since: string; token: string };

const NOT_RUNNING: DaemonStatus = { running: false, pid: null, since: null };
const START_WAIT_MS = 5000;
const POLITE_WAIT_MS = 10_000;
const POLL_MS = 100;
const posix = process.platform !== 'win32';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pidPath = (dataDir: string) => path.join(dataDir, 'runner.pid');

// kill(pid, 0) cannot tell a recycled pid from the daemon. Accepted: a pid file left by a crash
// that now names an unrelated live process reads as running, and stopDaemon only signals a pid
// whose file (pid and token) it has just re-read, so the window is small.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, not ours
  }
}

function readPidFile(dataDir: string): PidFile | null | 'stale' {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<PidFile>;
    if (
      Number.isSafeInteger(v.pid) &&
      (v.pid as number) > 0 &&
      typeof v.since === 'string' &&
      typeof v.token === 'string'
    ) {
      return v as PidFile;
    }
  } catch {
    // fall through
  }
  return 'stale';
}

const removePidFile = (dataDir: string) => fs.rmSync(pidPath(dataDir), { force: true });

function readLive(dataDir: string): PidFile | null {
  const f = readPidFile(dataDir);
  if (f === null) return null;
  if (f === 'stale' || !isAlive(f.pid)) {
    removePidFile(dataDir);
    return null;
  }
  return f;
}

export function daemonStatus(dataDir: string): DaemonStatus {
  const f = readLive(dataDir);
  return f ? { running: true, pid: f.pid, since: f.since } : { ...NOT_RUNNING };
}

/** Called by the background process itself on start. */
export function claimPidFile(dataDir: string): { release(): void } {
  const held = readLive(dataDir);
  if (held && held.pid !== process.pid) throw new Error('goat-runner is already running');
  fs.mkdirSync(dataDir, { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
  const token = randomBytes(8).toString('hex');
  const body: PidFile = { pid: process.pid, since: new Date().toISOString(), token };
  removePidFile(dataDir); // the mode applies only to a new file
  fs.writeFileSync(pidPath(dataDir), JSON.stringify(body), posix ? { mode: 0o600 } : undefined);
  return {
    release() {
      const f = readPidFile(dataDir);
      if (f && f !== 'stale' && f.token === token) removePidFile(dataDir);
    },
  };
}

export async function startDaemon(opts: {
  cliPath: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  waitMs?: number;
}): Promise<DaemonStatus> {
  const current = daemonStatus(opts.dataDir);
  if (current.running) return current;

  const child = spawn(opts.nodePath ?? process.execPath, [opts.cliPath, 'run', '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: opts.env,
  });
  let failed = false;
  child.on('error', () => (failed = true));
  child.unref();
  const pid = child.pid;
  if (pid === undefined) return { ...NOT_RUNNING };

  const deadline = Date.now() + (opts.waitMs ?? START_WAIT_MS);
  for (;;) {
    const s = daemonStatus(opts.dataDir);
    if (s.running && s.pid === pid) return s;
    if (failed || Date.now() >= deadline) return { ...NOT_RUNNING };
    await sleep(POLL_MS);
  }
}

/** True if a running process was stopped. */
export async function stopDaemon(
  dataDir: string,
  opts: { politeWaitMs?: number } = {},
): Promise<boolean> {
  const first = readLive(dataDir);
  if (!first || first.pid === process.pid) return false; // never signal ourselves
  // Re-read before each signal: a stale file whose pid was recycled must not be signalled.
  const same = () => {
    const f = readPidFile(dataDir);
    return f !== null && f !== 'stale' && f.pid === first.pid && f.token === first.token ? f : null;
  };
  const stopped = () => same() === null || !isAlive(first.pid);

  if (posix) {
    // Only the daemon: it releases its own turns and reaps its own children on SIGTERM.
    try {
      process.kill(first.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    const deadline = Date.now() + (opts.politeWaitMs ?? POLITE_WAIT_MS);
    while (!stopped() && Date.now() < deadline) await sleep(POLL_MS);
  }
  // Windows has no polite signal; elsewhere this is the last resort.
  if (!stopped() && same()) await killTree(first.pid);
  if (same()) removePidFile(dataDir);
  return true;
}
