import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPidFile, daemonStatus, startDaemon, stopDaemon } from '../src/daemon.js';

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
  fs.rmSync(home, { recursive: true, force: true });
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
    expect(fs.existsSync(pidFile())).toBe(false);
    write({ pid: 'x' });
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
