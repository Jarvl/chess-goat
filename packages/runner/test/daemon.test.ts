import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spawn from 'cross-spawn';
import {
  AlreadyRunningError,
  claimPidFile,
  daemonStatus,
  startDaemon,
  stopDaemon,
} from '../src/daemon.js';

const FAKE = fileURLToPath(new URL('./support/fakeDaemon.mjs', import.meta.url));
const posix = process.platform !== 'win32';
let home: string;
let data: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-daemon-'));
  data = path.join(home, 'data');
});
afterEach(async () => {
  // Some tests plant a file naming this process or its parent: never signal those.
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(data, 'runner.pid'), 'utf8'));
    if (pid !== process.pid && pid !== process.ppid) await stopDaemon(data, { politeWaitMs: 500 });
  } catch {
    // no file
  }
  // A daemon that gave up waiting may still be running (the `silent` fake exits after 3 s) with
  // the data folder as its working folder, which on Windows keeps the folder from being removed.
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
});

const env = () => ({ ...process.env, GOAT_RUNNER_HOME: home });
const start = (extra: { waitMs?: number } = {}) =>
  startDaemon({ cliPath: FAKE, dataDir: data, env: env(), ...extra });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidFile = () => path.join(data, 'runner.pid');
const write = (v: unknown) => {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(pidFile(), typeof v === 'string' ? v : JSON.stringify(v));
};
// A pid that is certainly dead: a child that has already exited.
const deadPid = async () => {
  const { default: spawn } = await import('cross-spawn');
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => c.on('close', r));
  return c.pid as number;
};

const iso = (ms: number) => new Date(ms).toISOString();
const age = (secondsAgo: number) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(pidFile(), t, t);
};

describe('daemon', () => {
  it('starts detached, reports status, and a second start starts nothing', async () => {
    expect(daemonStatus(data)).toEqual({ running: false, pid: null, since: null });
    const s = await start();
    expect(s.running).toBe(true);
    expect(alive(s.pid as number)).toBe(true);
    expect(s.pid).not.toBe(process.pid);
    expect(daemonStatus(data)).toEqual(s);
    const again = await start();
    expect(again).toEqual(s);
  });

  it("starts it in the data folder, not in the caller's folder", async () => {
    await start();
    expect(fs.realpathSync(fs.readFileSync(path.join(data, 'cwd.txt'), 'utf8'))).toBe(
      fs.realpathSync(data),
    );
  });

  it('stops it, removes the pid file, and a second stop returns false', async () => {
    const s = await start();
    expect(await stopDaemon(data)).toBe(true);
    expect(fs.existsSync(pidFile())).toBe(false);
    expect(alive(s.pid as number)).toBe(false);
    expect(await stopDaemon(data)).toBe(false);
  });

  it.skipIf(!posix)('kills a daemon that ignores SIGTERM', { timeout: 20_000 }, async () => {
    const s = await startDaemon({
      cliPath: FAKE,
      dataDir: data,
      env: { ...env(), GOAT_FAKE_MODE: 'stubborn' },
    });
    expect(s.running).toBe(true);
    expect(await stopDaemon(data, { politeWaitMs: 500 })).toBe(true);
    await vi.waitFor(() => expect(alive(s.pid as number)).toBe(false), { timeout: 2000 }); // SIGKILL lands asynchronously
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('reports not running when the child never writes its pid file', async () => {
    const t0 = Date.now();
    const s = await startDaemon({
      cliPath: FAKE,
      dataDir: data,
      env: { ...env(), GOAT_FAKE_MODE: 'silent' },
      waitMs: 500,
    });
    expect(s).toEqual({ running: false, pid: null, since: null });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('treats a pid file naming a dead process as stale and removes it', async () => {
    write({ pid: await deadPid(), since: new Date().toISOString(), token: 'ab' });
    expect(daemonStatus(data).running).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('treats a malformed pid file as stale', () => {
    write('not json');
    expect(daemonStatus(data).running).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(true); // fresh: it may still be being written
    age(10);
    expect(daemonStatus(data).running).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(false);
    write({ pid: 'x' });
    age(10);
    expect(daemonStatus(data).running).toBe(false);
  });
});

describe('claimPidFile', () => {
  it('writes this process, and release removes only its own file', () => {
    const claim = claimPidFile(data);
    const f = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
    expect(f.pid).toBe(process.pid);
    expect(f.token).toMatch(/^[0-9a-f]{16}$/);
    expect(daemonStatus(data).pid).toBe(process.pid);
    claim.release();
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('refuses when a live process holds the file', () => {
    write({ pid: process.ppid, since: new Date().toISOString(), token: 'other' });
    expect(() => claimPidFile(data)).toThrow('goat-runner is already running');
  });

  it('takes over a stale file', async () => {
    write({ pid: await deadPid(), since: new Date().toISOString(), token: 'old' });
    const claim = claimPidFile(data);
    expect(daemonStatus(data).pid).toBe(process.pid);
    claim.release();
  });

  it('release leaves a file with a different token alone', () => {
    const claim = claimPidFile(data);
    write({ pid: process.ppid, since: new Date().toISOString(), token: 'someone-else' });
    claim.release();
    expect(fs.existsSync(pidFile())).toBe(true);
  });

  it.skipIf(!posix)('creates the folder 0700 and the file 0600', () => {
    const claim = claimPidFile(data);
    expect(fs.statSync(data).mode & 0o777).toBe(0o700);
    expect(fs.statSync(pidFile()).mode & 0o777).toBe(0o600);
    claim.release();
  });
});

const WORKER = fileURLToPath(new URL('./support/claimWorker.ts', import.meta.url));
const PKG = fileURLToPath(new URL('..', import.meta.url));
describe('one runner at a time', () => {
  it('lets exactly one of 8 simultaneous claimers win', { timeout: 30_000 }, async () => {
    const startAt = Date.now() + 1500;
    const workers = Array.from({ length: 8 }, () => {
      const c = spawn(process.execPath, ['--import', 'tsx', WORKER, data, String(startAt)], {
        cwd: PKG,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let out = '';
      const first = new Promise<string>((r) =>
        c.stdout?.on('data', (d) => {
          out += d;
          if (out.includes('\n')) r(out.trim());
        }),
      );
      const closed = new Promise<void>((r) => c.on('close', () => r()));
      return { c, first, closed };
    });
    // Every worker has answered while the winner still holds the claim; only then let go.
    const outs = await Promise.all(workers.map((w) => w.first));
    for (const w of workers) w.c.stdin?.end();
    await Promise.all(workers.map((w) => w.closed));
    expect(outs.filter((o) => o.startsWith('won'))).toHaveLength(1);
    expect(outs.filter((o) => o === 'lost')).toHaveLength(7);
  });

  it('throws AlreadyRunningError for a live holder, and a repeat claim here is the same handle', () => {
    write({ pid: process.ppid, since: iso(Date.now()), token: 'other' });
    expect(() => claimPidFile(data)).toThrow(AlreadyRunningError);
    expect(() => claimPidFile(data)).toThrow('goat-runner is already running');
    fs.rmSync(pidFile());
    const claim = claimPidFile(data);
    expect(claimPidFile(data)).toBe(claim); // our own file: the same handle
    claim.release();
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('does not delete a stale file that someone replaced after we read it', async () => {
    // A live claim planted between our read and removal is simulated by a file that is stale
    // (dead pid) but replaced mid-claim via the test seam.
    write({ pid: await deadPid(), since: iso(Date.now()), token: 'old' });
    const fresh = JSON.stringify({ pid: process.ppid, since: iso(Date.now()), token: 'new' });
    expect(() => claimPidFile(data, { onStale: () => write(fresh) })).toThrow(AlreadyRunningError);
    expect(fs.readFileSync(pidFile(), 'utf8')).toBe(fresh);
  });

  it('does not take a fresh half-written (empty) file for a stale one', () => {
    write('');
    expect(() => claimPidFile(data)).toThrow(AlreadyRunningError);
    expect(fs.existsSync(pidFile())).toBe(true);
    age(10); // an old malformed file is stale
    claimPidFile(data).release();
  });
});

// Fake /proc: a boot id, and a stat line whose field 22 is `ticks` (the comm holds a paren).
const fakeProc = (boot: string, ticks: number) => (file: string) => {
  if (file.endsWith('boot_id')) return `${boot}\n`;
  return `1 (we ird)) ${['S', ...Array(18).fill('0'), String(ticks)].join(' ')} 0 0`;
};

describe('stale pid files', () => {
  it('a file older than the boot is stale even though its pid is alive', () => {
    write({ pid: process.pid, since: iso(Date.now() - 3600_000), token: 't' });
    expect(daemonStatus(data, { uptimeSeconds: 60, platform: 'darwin' }).running).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('the same file written since boot is running', () => {
    write({ pid: process.pid, since: iso(Date.now()), token: 't' });
    expect(daemonStatus(data, { uptimeSeconds: 60, platform: 'darwin' }).running).toBe(true);
  });

  it('claim takes over a boot-stale file', () => {
    write({ pid: process.ppid, since: iso(Date.now() - 3600_000), token: 't' });
    const claim = claimPidFile(data, { uptimeSeconds: 60, platform: 'darwin' });
    expect(daemonStatus(data).pid).toBe(process.pid);
    claim.release();
  });

  it('stop does not signal a boot-stale file', async () => {
    write({ pid: process.ppid, since: iso(Date.now() - 3600_000), token: 't' });
    expect(await stopDaemon(data, { uptimeSeconds: 60, platform: 'darwin' })).toBe(false);
    expect(alive(process.ppid)).toBe(true);
  });

  it('a live daemon stays live when the wall clock steps forward (Linux identity)', () => {
    const f = {
      pid: process.pid,
      since: iso(Date.now()),
      token: 't',
      bootId: 'B1',
      startTicks: 777,
    };
    write(f);
    const clock = {
      platform: 'linux' as const,
      readProc: fakeProc('B1', 777),
      now: () => Date.now() + 3600_000,
      uptimeSeconds: 60,
    };
    expect(daemonStatus(data, clock).running).toBe(true);
  });

  it('a different boot id is stale although the pid is alive', () => {
    write({ pid: process.pid, since: iso(Date.now()), token: 't', bootId: 'B1', startTicks: 777 });
    expect(daemonStatus(data, { platform: 'linux', readProc: fakeProc('B2', 777) }).running).toBe(
      false,
    );
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('the same boot but different start ticks is stale (pid reused)', () => {
    write({ pid: process.pid, since: iso(Date.now()), token: 't', bootId: 'B1', startTicks: 777 });
    expect(daemonStatus(data, { platform: 'linux', readProc: fakeProc('B1', 778) }).running).toBe(
      false,
    );
  });

  it('unreadable /proc falls back to alive means live', () => {
    write({ pid: process.pid, since: iso(Date.now()), token: 't', bootId: 'B1', startTicks: 777 });
    const broken = () => {
      throw new Error('EACCES');
    };
    expect(daemonStatus(data, { platform: 'linux', readProc: broken }).running).toBe(true);
  });

  it('a file without identity fields (older) is live when the pid is alive, whatever the clock', () => {
    write({ pid: process.pid, since: iso(Date.now() - 3600_000), token: 't' });
    expect(
      daemonStatus(data, { platform: 'linux', uptimeSeconds: 60, readProc: fakeProc('B1', 1) })
        .running,
    ).toBe(true);
  });

  it('claim records the boot id and start ticks on Linux', () => {
    const claim = claimPidFile(data, { platform: 'linux', readProc: fakeProc('B9', 4242) });
    const f = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
    expect([f.bootId, f.startTicks]).toEqual(['B9', 4242]);
    claim.release();
  });

  it('elsewhere, a current uptime below the recorded one is stale (a reboot)', () => {
    write({ pid: process.pid, since: iso(Date.now()), token: 't', uptime: 5000 });
    expect(daemonStatus(data, { platform: 'darwin', uptimeSeconds: 100 }).running).toBe(false);
    write({ pid: process.pid, since: iso(Date.now()), token: 't', uptime: 5000 });
    expect(daemonStatus(data, { platform: 'darwin', uptimeSeconds: 6000 }).running).toBe(true);
  });

  it('a malformed file with a future mtime is not fresh', () => {
    write('');
    const t = new Date(Date.now() + 3600_000);
    fs.utimesSync(pidFile(), t, t);
    expect(daemonStatus(data).running).toBe(false);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('does not delete a dead pid file that changed since it was read', async () => {
    write({ pid: await deadPid(), since: iso(Date.now()), token: 'old' });
    const fresh = JSON.stringify({ pid: process.ppid, since: iso(Date.now()), token: 'new' });
    daemonStatus(data, { onStale: () => write(fresh) });
    expect(fs.readFileSync(pidFile(), 'utf8')).toBe(fresh);
  });
});

describe('startDaemon outcomes', () => {
  it('returns the running daemon when the spawned child lost the claim', async () => {
    const t0 = Date.now();
    const p = startDaemon({
      cliPath: FAKE,
      dataDir: data,
      env: { ...env(), GOAT_FAKE_MODE: 'exit' },
    });
    write({ pid: process.ppid, since: iso(Date.now()), token: 'winner' });
    const s = await p;
    expect(s.running).toBe(true);
    expect(s.pid).toBe(process.ppid);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('returns at once when the child exits without a daemon running', async () => {
    const t0 = Date.now();
    const s = await startDaemon({
      cliPath: FAKE,
      dataDir: data,
      env: { ...env(), GOAT_FAKE_MODE: 'exit' },
      waitMs: 5000,
    });
    expect(s.running).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('returns not running when the spawn fails', async () => {
    const s = await startDaemon({
      cliPath: FAKE,
      dataDir: data,
      nodePath: path.join(home, 'no-such-node'),
      env: env(),
    });
    expect(s).toEqual({ running: false, pid: null, since: null });
  });
});

describe('stopDaemon honesty', () => {
  const planted = () => {
    const c = spawn(process.execPath, [FAKE], {
      stdio: 'ignore',
      env: { ...env(), GOAT_FAKE_MODE: 'silent' },
    });
    return c;
  };

  it('does not signal when the pid file changed identity between reads', async () => {
    const c = planted();
    try {
      write({ pid: c.pid, since: iso(Date.now()), token: 'a' });
      const r = await stopDaemon(data, {
        politeWaitMs: 300,
        onRead: () => write({ pid: c.pid, since: iso(Date.now()), token: 'b' }),
      });
      expect(r).toBe(false);
      expect(alive(c.pid as number)).toBe(true);
    } finally {
      c.kill('SIGKILL');
    }
  });

  it('never accepts pid 1 or below (kill(-1) would signal everything)', () => {
    write({ pid: 1, since: iso(Date.now()), token: 'init' });
    expect(daemonStatus(data).running).toBe(false);
  });
});
