import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { childEnv, runSession, type SessionSpec } from '../src/session.js';

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

describe('runSession', { timeout: 30_000 }, () => {
  it('reports a clean exit with output', async () => {
    const r = await runSession(fake('ok'), { timeoutMs: 20_000 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.tail).toContain('ok');
  });

  it('reports a non-zero exit as exited with its code', async () => {
    const r = await runSession(fake('fail'), { timeoutMs: 20_000 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 3 });
    expect(r.tail).toContain('nope');
  });

  it('kills a hanging harness and its grandchild at the time limit', async () => {
    // Two node processes must start and print before the limit, so leave room on slow CI.
    const r = await runSession(fake('fork'), { timeoutMs: 4000 });
    expect(r).toMatchObject({ reason: 'timeout' });
    expect(r.ms).toBeGreaterThanOrEqual(3900);
    expect(r.ms).toBeLessThan(12_000);
    const pid = grandchildPid(r.tail);
    expect(pid).toBeGreaterThan(0);
    await expectGone(pid);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL for a harness that ignores SIGTERM',
    async () => {
      // The limit leaves time for the SIGTERM handler to be installed ("stubborn" proves it was);
      // the 2 s grace must then really elapse before SIGKILL, or SIGTERM alone would have won.
      const r = await runSession(fake('ignore-term'), { timeoutMs: 2000 });
      expect(r.reason).toBe('timeout');
      expect(r.tail).toContain('stubborn');
      expect(r.ms).toBeGreaterThanOrEqual(3900);
      expect(r.ms).toBeLessThan(15_000);
      expect(r.tail).not.toContain('did not exit');
    },
    30_000,
  );

  it('treats an abort signal fired mid-run as a timeout', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await runSession(fake('hang'), { timeoutMs: 20_000, signal: ac.signal });
    expect(r.reason).toBe('timeout');
    expect(r.ms).toBeGreaterThanOrEqual(450);
    expect(r.ms).toBeLessThan(10_000);
  }, 30_000);

  it('does not spawn when the signal is already aborted', async () => {
    const r = await runSession(
      { ...fake('ok'), command: 'definitely-not-a-real-command-xyz' },
      { timeoutMs: 20_000, signal: AbortSignal.abort() },
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
    const r = await runSession(spec, { timeoutMs: 20_000 });
    expect(r.tail).toContain('[redacted]');
    expect(r.tail).not.toContain('abcdef123456');
  });

  it('does not redact short values or variables not named like a secret', async () => {
    const short = fake('echo-env', 'MY_API_KEY');
    short.env = { MY_API_KEY: 'short' };
    expect((await runSession(short, { timeoutMs: 20_000 })).tail).toContain('short');

    const plain = fake('echo-env', 'GREETING');
    plain.env = { GREETING: 'hello-world-long' };
    expect((await runSession(plain, { timeoutMs: 20_000 })).tail).toContain('hello-world-long');
  });

  it('writes spec.stdin to the child', async () => {
    const spec = { ...fake('stdin'), stdin: 'twelve chars' };
    const r = await runSession(spec, { timeoutMs: 20_000 });
    expect(r.tail.trim()).toBe('12');
  });

  it('closes stdin when none is given', async () => {
    const r = await runSession(fake('stdin'), { timeoutMs: 20_000 });
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
      { timeoutMs: 20_000 },
    );
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(r.tail).toContain('definitely-not-a-real-command-xyz could not be started');
    expect(r.tail).not.toContain('SECRET-PROMPT-TEXT');
    expect(r.tail).not.toContain('--prompt');
  });

  it('hides GOAT_RUNNER_* from the child but keeps PATH', async () => {
    process.env.GOAT_RUNNER_HOME = '/should/not/leak';
    try {
      const home = await runSession(fake('echo-env', 'GOAT_RUNNER_HOME'), { timeoutMs: 20_000 });
      expect(home.tail.trim()).toBe('');
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
      const path = await runSession(fake('echo-env', pathKey), { timeoutMs: 20_000 });
      expect(path.tail.trim()).not.toBe('');
    } finally {
      delete process.env.GOAT_RUNNER_HOME;
    }
  });

  it('resolves on exit when a grandchild keeps stdout open, and reaps it', async () => {
    const r = await runSession(fake('orphan-stdout'), { timeoutMs: 20_000 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.ms).toBeLessThan(5000); // well under the drain grace plus a SIGKILL escalation
    const pid = grandchildPid(r.tail);
    expect(pid).toBeGreaterThan(0);
    if (process.platform !== 'win32') await expectGone(pid);
    else expect(alive(pid)).toBe(true); // documented limitation: not reaped on Windows
    if (process.platform === 'win32') process.kill(pid); // clean up after the test
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'reports a child killed by a signal we did not send as exited with a null code',
    async () => {
      const r = await runSession(fake('self-kill'), { timeoutMs: 20_000 });
      expect(r).toMatchObject({ reason: 'exited', exitCode: null });
    },
    30_000,
  );

  it('resolves error, not a rejection, when spawn throws, without echoing values', async () => {
    const badArg = { ...fake('ok'), args: [HARNESS, 'ok', 'arg\0ARGSECRET1'] };
    const a = await runSession(badArg, { timeoutMs: 20_000 });
    expect(a).toMatchObject({ reason: 'error', exitCode: null });
    expect(a.tail).toContain('could not be started');
    expect(a.tail).not.toContain('ARGSECRET1');

    const badEnv = { ...fake('ok'), env: { GOAT_TURN_TOKEN: 'tok\0ENVSECRET1' } };
    const e = await runSession(badEnv, { timeoutMs: 20_000 });
    expect(e).toMatchObject({ reason: 'error', exitCode: null });
    expect(e.tail).not.toContain('ENVSECRET1');
  });

  it('redacts the longer secret first when one value contains another', async () => {
    const spec = fake('echo-env', 'LONG_SECRET');
    spec.env = { SHORT_TOKEN: 'abcdefgh', LONG_SECRET: 'abcdefgh-longer' };
    const r = await runSession(spec, { timeoutMs: 20_000 });
    expect(r.tail.trim()).toBe('[redacted]');
  });
});

describe('childEnv', () => {
  it('drops GOAT_RUNNER_* and applies extras', () => {
    const env = childEnv({ PATH: '/bin', GOAT_RUNNER_HOME: '/x', A: '1' }, { A: '2' }, 'linux');
    expect(env).toEqual({ PATH: '/bin', A: '2' });
  });

  it('on Windows matches the prefix and overridden names case-insensitively', () => {
    const env = childEnv(
      { Path: 'C:\\bin', goat_runner_home: 'x', Goat_Turn_Token: 'old', Other: '1' },
      { GOAT_TURN_TOKEN: 'new' },
      'win32',
    );
    expect(env).toEqual({ Path: 'C:\\bin', Other: '1', GOAT_TURN_TOKEN: 'new' });
  });

  it('on POSIX keeps names that differ only by case', () => {
    const env = childEnv({ foo: 'a' }, { FOO: 'b' }, 'linux');
    expect(env).toEqual({ foo: 'a', FOO: 'b' });
  });
});
