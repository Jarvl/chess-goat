import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runSession, type SessionSpec } from '../src/session.js';

const HARNESS = fileURLToPath(new URL('./support/fakeHarness.mjs', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'goat-session-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function fake(mode: string, ...args: string[]): SessionSpec {
  return { command: process.execPath, args: [HARNESS, mode, ...args], env: {}, cwd };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(alive(pid)).toBe(false);
}

const grandchildPid = (tail: string) => Number(/grandchild (\d+)/.exec(tail)?.[1]);

describe('runSession', () => {
  it('reports a clean exit with output', async () => {
    const r = await runSession(fake('ok'), { timeoutMs: 5000 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.tail).toContain('ok');
  });

  it('reports a non-zero exit as exited with its code', async () => {
    const r = await runSession(fake('fail'), { timeoutMs: 5000 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 3 });
    expect(r.tail).toContain('nope');
  });

  it('kills a hanging harness and its grandchild at the time limit', async () => {
    const t0 = Date.now();
    const r = await runSession(fake('fork'), { timeoutMs: 600 });
    expect(r).toMatchObject({ reason: 'timeout' });
    expect(r.ms).toBeGreaterThanOrEqual(550);
    expect(r.ms).toBeLessThan(3000);
    expect(Date.now() - t0).toBeLessThan(4000);
    const pid = grandchildPid(r.tail);
    expect(pid).toBeGreaterThan(0);
    await expectGone(pid);
  });

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL for a harness that ignores SIGTERM',
    async () => {
      const r = await runSession(fake('ignore-term'), { timeoutMs: 500 });
      expect(r.reason).toBe('timeout');
      expect(r.ms).toBeLessThan(3500);
      expect(r.tail).not.toContain('did not exit');
    },
  );

  it('treats an abort signal fired mid-run as a timeout', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const r = await runSession(fake('hang'), { timeoutMs: 20_000, signal: ac.signal });
    expect(r.reason).toBe('timeout');
    expect(r.ms).toBeLessThan(3000);
  });

  it('does not spawn when the signal is already aborted', async () => {
    const r = await runSession(
      { ...fake('ok'), command: 'definitely-not-a-real-command-xyz' },
      { timeoutMs: 5000, signal: AbortSignal.abort() },
    );
    expect(r.reason).toBe('timeout');
    expect(r.exitCode).toBeNull();
    expect(r.tail).not.toContain('could not be started');
  });

  it('keeps exactly the last 2,000 characters and bounded memory', async () => {
    const r = await runSession(fake('spam', '5000'), { timeoutMs: 15_000 });
    expect(r.reason).toBe('exited');
    expect(r.tail).toHaveLength(2000);
    expect(r.tail.trimEnd().endsWith('4999')).toBe(true);
  });

  it('passes env to the child and redacts secret-named values in the tail', async () => {
    const spec = fake('echo-env', 'GOAT_TURN_TOKEN');
    spec.env = { GOAT_TURN_TOKEN: 'tok-abcdef123456' };
    const r = await runSession(spec, { timeoutMs: 5000 });
    expect(r.tail).toContain('[redacted]');
    expect(r.tail).not.toContain('abcdef123456');
  });

  it('does not redact short values or variables not named like a secret', async () => {
    const short = fake('echo-env', 'MY_API_KEY');
    short.env = { MY_API_KEY: 'short' };
    expect((await runSession(short, { timeoutMs: 5000 })).tail).toContain('short');

    const plain = fake('echo-env', 'GREETING');
    plain.env = { GREETING: 'hello-world-long' };
    expect((await runSession(plain, { timeoutMs: 5000 })).tail).toContain('hello-world-long');
  });

  it('writes spec.stdin to the child', async () => {
    const spec = { ...fake('stdin'), stdin: 'twelve chars' };
    const r = await runSession(spec, { timeoutMs: 5000 });
    expect(r.tail.trim()).toBe('12');
  });

  it('closes stdin when none is given', async () => {
    const r = await runSession(fake('stdin'), { timeoutMs: 5000 });
    expect(r.reason).toBe('exited');
    expect(r.tail.trim()).toBe('0');
  });

  it('reports a missing command as error without throwing or echoing arguments', async () => {
    const r = await runSession(
      {
        command: 'definitely-not-a-real-command-xyz',
        args: ['--prompt', 'SECRET-PROMPT-TEXT'],
        env: {},
        cwd,
      },
      { timeoutMs: 5000 },
    );
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(r.tail).toContain('definitely-not-a-real-command-xyz could not be started');
    expect(r.tail).not.toContain('SECRET-PROMPT-TEXT');
    expect(r.tail).not.toContain('--prompt');
  });

  it('hides GOAT_RUNNER_* from the child but keeps PATH', async () => {
    process.env.GOAT_RUNNER_HOME = '/should/not/leak';
    try {
      const home = await runSession(fake('echo-env', 'GOAT_RUNNER_HOME'), { timeoutMs: 5000 });
      expect(home.tail.trim()).toBe('');
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
      const path = await runSession(fake('echo-env', pathKey), { timeoutMs: 5000 });
      expect(path.tail.trim()).not.toBe('');
    } finally {
      delete process.env.GOAT_RUNNER_HOME;
    }
  });
});
