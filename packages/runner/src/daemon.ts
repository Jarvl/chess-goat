import spawn from 'cross-spawn';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree } from './session.js';

export type DaemonStatus = { running: boolean; pid: number | null; since: string | null };
type PidFile = { pid: number; since: string; token: string };
/** Injectable clock and uptime, so tests can pretend a reboot happened. */
type Clock = { now?: () => number; uptimeSeconds?: number };
// onStale/onRead are test seams: they run between a read and the action taken on it.
type Seams = { onStale?: () => void };

/** Another goat-runner already holds the pid file. */
export class AlreadyRunningError extends Error {
  constructor() {
    super('goat-runner is already running');
    this.name = 'AlreadyRunningError';
  }
}

const NOT_RUNNING: DaemonStatus = { running: false, pid: null, since: null };
const START_WAIT_MS = 5000;
const POLITE_WAIT_MS = 10_000;
const DEATH_WAIT_MS = 2000;
const POLL_MS = 100;
const BOOT_TOLERANCE_MS = 5000;
const START_TOLERANCE_MS = 5000;
const MALFORMED_GRACE_MS = 2000;
const CLK_TCK = 100; // every Linux in practice
const posix = process.platform !== 'win32';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pidPath = (dataDir: string) => path.join(dataDir, 'runner.pid');

// kill(pid, 0) cannot tell a recycled pid from the daemon. Two further checks only ever make a
// file MORE likely to be judged stale: it predates the machine's boot, or (Linux) its process
// started after the file says the daemon did. Anything else that recycles a pid within one boot
// stays undetected; stopDaemon only signals a pid whose file (pid and token) it has just re-read.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, not ours
  }
}

// Process start (epoch ms) from /proc, or null when it cannot be read.
function linuxStartMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (comm) may contain spaces and parens: parse from the last ')'. Field 22 is the
    // 20th after it (fields from 3 on).
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const btime = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    if (!Number.isFinite(ticks) || !btime) return null;
    return (Number(btime[1]) + ticks / CLK_TCK) * 1000;
  } catch {
    return null;
  }
}

type Loaded = { raw: string; file: PidFile | null; fresh: boolean };

function load(dataDir: string): Loaded | null {
  let raw: string;
  let fresh: boolean;
  try {
    raw = fs.readFileSync(pidPath(dataDir), 'utf8');
    fresh = Date.now() - fs.statSync(pidPath(dataDir)).mtimeMs < MALFORMED_GRACE_MS;
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<PidFile>;
    if (
      Number.isSafeInteger(v.pid) &&
      (v.pid as number) > 1 && // kill(-1) would signal everything we may
      typeof v.since === 'string' &&
      typeof v.token === 'string'
    ) {
      return { raw, file: v as PidFile, fresh };
    }
  } catch {
    // malformed
  }
  return { raw, file: null, fresh };
}

function isLive(l: Loaded, clock: Clock): boolean {
  // A file another process is still writing looks malformed for a moment: not stale yet.
  if (!l.file) return l.fresh;
  const since = Date.parse(l.file.since);
  const now = (clock.now ?? Date.now)();
  const uptime = clock.uptimeSeconds ?? os.uptime();
  if (!Number.isFinite(since) || since < now - uptime * 1000 - BOOT_TOLERANCE_MS) return false;
  if (!isAlive(l.file.pid)) return false;
  const started = linuxStartMs(l.file.pid);
  return started === null || started <= since + START_TOLERANCE_MS;
}

// Removes the file only if it still holds what we judged stale: it may have been re-claimed.
function removeIfUnchanged(dataDir: string, raw: string): boolean {
  try {
    if (fs.readFileSync(pidPath(dataDir), 'utf8') !== raw) return false;
    fs.rmSync(pidPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

function readLive(dataDir: string, clock: Clock, seams: Seams = {}): PidFile | null {
  const l = load(dataDir);
  if (!l) return null;
  if (isLive(l, clock)) return l.file;
  seams.onStale?.();
  // A fresh malformed file is someone mid-write: leave it.
  if (l.file || !l.fresh) removeIfUnchanged(dataDir, l.raw);
  return null;
}

export function daemonStatus(dataDir: string, opts: Clock & Seams = {}): DaemonStatus {
  const f = readLive(dataDir, opts, opts);
  return f ? { running: true, pid: f.pid, since: f.since } : { ...NOT_RUNNING };
}

const held = new Map<string, { token: string; handle: { release(): void } }>();

/**
 * Called by the background process itself on start. The file is created exclusively, so of any
 * number of simultaneous starters exactly one wins; the rest get AlreadyRunningError.
 */
export function claimPidFile(dataDir: string, opts: Clock & Seams = {}): { release(): void } {
  const file = pidPath(dataDir);
  const mine = held.get(file);
  fs.mkdirSync(dataDir, { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
  const token = randomBytes(8).toString('hex');
  const text = JSON.stringify({
    pid: process.pid,
    since: new Date((opts.now ?? Date.now)()).toISOString(),
    token,
  } satisfies PidFile);

  let created = false;
  for (let attempt = 0; attempt < 2 && !created; attempt++) {
    try {
      fs.writeFileSync(file, text, { flag: 'wx', ...(posix ? { mode: 0o600 } : {}) });
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = load(dataDir);
      if (!cur) continue; // vanished since: try the create again
      if (mine && cur.file?.token === mine.token) return mine.handle;
      if (isLive(cur, opts)) throw new AlreadyRunningError();
      opts.onStale?.();
      // Changed since we read it: someone else just claimed.
      if (!removeIfUnchanged(dataDir, cur.raw)) throw new AlreadyRunningError();
    }
  }
  if (!created) throw new AlreadyRunningError();
  if (load(dataDir)?.file?.token !== token) throw new AlreadyRunningError();

  const handle = {
    release() {
      held.delete(file);
      const l = load(dataDir);
      if (l?.file?.token === token) removeIfUnchanged(dataDir, l.raw);
    },
  };
  held.set(file, { token, handle });
  return handle;
}

export async function startDaemon(opts: {
  cliPath: string;
  dataDir: string;
  /** Replaces the daemon's environment; by default it inherits ours. When set, the caller must
   * carry GOAT_RUNNER_HOME itself if `dataDir` was derived from it. */
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
  const ended = new Promise<void>((resolve) => {
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
  child.unref();
  if (child.pid === undefined) return { ...NOT_RUNNING };

  let over = false;
  void ended.then(() => (over = true));
  const deadline = Date.now() + (opts.waitMs ?? START_WAIT_MS);
  for (;;) {
    // Whoever holds the file is the answer: our child may have lost the claim to another start.
    const s = daemonStatus(opts.dataDir);
    if (s.running) return s;
    if (over || Date.now() >= deadline) return { ...NOT_RUNNING };
    await Promise.race([sleep(POLL_MS), ended]);
    if (over) return daemonStatus(opts.dataDir);
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** True only if the process is gone at the end. */
export async function stopDaemon(
  dataDir: string,
  opts: Clock & { politeWaitMs?: number; onRead?: () => void } = {},
): Promise<boolean> {
  const first = readLive(dataDir, opts);
  if (!first || first.pid === process.pid) return false; // never signal ourselves
  opts.onRead?.();
  // Re-read before each signal: a file whose pid was recycled or re-claimed must not be signalled.
  const same = () => {
    const l = load(dataDir);
    return l?.file?.pid === first.pid && l.file.token === first.token ? l : null;
  };

  if (posix) {
    if (!same()) return false;
    // The daemon alone, not its group: `run --daemon` must honour SIGTERM by releasing its
    // turns, stopping its sessions and removing its pid file, then exiting.
    try {
      process.kill(first.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    // Wait for the PROCESS to die: the file goes first, the daemon may still be finishing.
    await waitDead(first.pid, opts.politeWaitMs ?? POLITE_WAIT_MS);
  }
  if (isAlive(first.pid)) {
    if (!same()) return false;
    // Last resort, and the only option on Windows (no polite signal there). A daemon killed this
    // way cannot release its turns or stop its sessions: sessions run in their own process
    // groups and go on until their own time limit, and their turns lapse and count as failures.
    await killTree(first.pid);
    if (!(await waitDead(first.pid, DEATH_WAIT_MS))) return false; // not stopped: keep the file
  }
  const left = same();
  if (left) removeIfUnchanged(dataDir, left.raw);
  return true;
}
