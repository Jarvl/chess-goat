import spawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { startDaemon, stopDaemon } from '../src/daemon.js';
import { sendJson, type TestServer } from './support/httpServer';
import { buildOnce } from './support/build';
import { CREDENTIAL, GOOD_CODE, runnerServer } from './support/linkServer';
import { CLI, run } from './support/run';

const FAKE_DAEMON = fileURLToPath(new URL('./support/fakeDaemon.mjs', import.meta.url));
const posix = process.platform !== 'win32';
let home: string;
let server: TestServer | undefined;
const everything: string[] = [];

beforeAll(async () => {
  await buildOnce();
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-cli-e2e-'));
});
afterEach(async () => {
  // Tests that started a stand-in daemon in `home` must not leave it behind.
  await stopDaemon(path.join(home, 'data'), { politeWaitMs: 500 }).catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  await server?.close();
  server = undefined;
  everything.length = 0;
});

// Every run goes through here: stdin closed, a temporary home, and the output kept for the
// "never the credential, never a stack trace" checks.
async function cli(args: string[], env: Record<string, string> = {}) {
  const res = await run(args, { env: { GOAT_RUNNER_HOME: home, ...env } });
  everything.push(res.stdout, res.stderr);
  if (res.code !== 0) expect(res.stderr).not.toMatch(/ {4}at /);
  return res;
}

async function linked(opts: Parameters<typeof runnerServer>[0] = {}) {
  server = await runnerServer(opts);
  const res = await cli([
    'link',
    GOOD_CODE,
    '--server',
    server.url,
    '--preset',
    'claude',
    '--no-start',
    '--no-autostart',
    '--json',
  ]);
  expect(res.code).toBe(0);
  return res;
}

const configFile = () => path.join(home, 'config', 'config.json');

describe('basics', () => {
  it('prints its version', async () => {
    const { stdout, code } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it('prints help with no arguments and with --help, exit 0', async () => {
    for (const args of [[], ['--help'], ['link', '--help']]) {
      const { stdout, code } = await cli(args);
      expect(code).toBe(0);
      expect(stdout).toContain('Usage: goat-runner');
    }
  });

  it('rejects an unknown command with exit 2 and the usage', async () => {
    const { stderr, code } = await cli(['nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown command');
    expect(stderr).toContain('Usage: goat-runner');
  });

  it('the built file has a shebang and imports nothing from the workspace', () => {
    const built = fs.readFileSync(CLI, 'utf8');
    expect(built.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(built).not.toContain('@chess-goat/shared');
  });
});

describe('link', () => {
  it('links end to end with --json and writes the config', async () => {
    const res = await linked();
    expect(JSON.parse(res.stdout)).toEqual({
      linked: true,
      runner_id: 7,
      preset: 'claude',
      started: false,
      autostart: false,
      autostart_detail: 'skipped (--no-autostart)',
    });
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(config).toMatchObject({ server: server!.url, runnerId: 7, preset: 'claude' });
    expect(config.credential).toBe(CREDENTIAL);
    const req = server!.requests[0]!;
    expect(req.path).toBe('/runner/link');
    expect(req.body).toMatchObject({ code: GOOD_CODE, harness: 'claude' });
    expect(typeof (req.body as { label: string }).label).toBe('string');
  });

  it('a wrong code exits 1 with the server sentence and changes nothing', async () => {
    server = await runnerServer();
    const res = await cli(['link', 'bad', '--server', server.url, '--preset', 'claude']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('wrong, already used, or expired');
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('a second link keeps the old config when the new code is refused', async () => {
    await linked();
    const before = fs.readFileSync(configFile(), 'utf8');
    const res = await cli(['link', 'bad', '--server', server!.url, '--preset', 'claude']);
    expect(res.code).toBe(1);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
  });

  it('refuses plain http to a remote host with one sentence', async () => {
    const res = await cli(['link', 'x', '--server', 'http://example.com', '--preset', 'claude']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('the server address must use https');
  });

  it('refuses codex without --allow-unverified (exit 2), before contacting the server', async () => {
    server = await runnerServer();
    const res = await cli(['link', GOOD_CODE, '--server', server.url, '--preset', 'codex']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--allow-unverified');
    expect(server.requests).toHaveLength(0);
  });
});

describe('status, stop, unlink', () => {
  it('status --json before and after linking, without the credential', async () => {
    const before = await cli(['status', '--json']);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({
      linked: false,
      running: false,
      server: null,
      preset: null,
    });
    await linked();
    const after = JSON.parse((await cli(['status', '--json'])).stdout);
    expect(after).toMatchObject({
      linked: true,
      runner_id: 7,
      server: server!.url,
      preset: 'claude',
      running: false,
    });
    expect(JSON.stringify(after)).not.toContain('credential');
    const text = await cli(['status']);
    expect(text.stdout).toContain('runner 7');
    // `status` probes this machine's real login unit (read-only): never assert on its state.
  });

  it('stop with nothing running exits 0', async () => {
    const res = await cli(['stop']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('was not running');
  });

  it('logs prints one log line per line', async () => {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'runner.log'), 'one\ntwo\nthree\n');
    const res = await cli(['logs']);
    expect(res.stdout.trimEnd().split('\n')).toEqual(['one', 'two', 'three']);
    const json = JSON.parse((await cli(['logs', '-n', '2', '--json'])).stdout);
    expect(json.lines).toEqual(['two', 'three']);
  });

  it('logs with no log yet exits 0', async () => {
    expect((await cli(['logs', '-n', '5'])).code).toBe(0);
    expect((await cli(['logs', '-n', 'x'])).code).toBe(2);
  });
  // unlink runs the real autostart removal, which would touch this machine's own login unit: it is
  // tested in commands.test.ts with a fake instead.
});

describe('run', () => {
  it('unlinked exits 1 with the fixed sentence', async () => {
    const res = await cli(['run']);
    expect(res.code).toBe(1);
    expect(res.stderr.trim()).toBe(
      'Not linked. Ask your agent to call link_runner and run the command it gives.',
    );
  });

  it('a broken config exits 1 with one sentence', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        server: 'http://127.0.0.1:1',
        credential: 'c',
        runnerId: 1,
        preset: 'custom',
      }),
    );
    const res = await cli(['run']);
    expect(res.code).toBe(1);
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).toContain('custom');
  });

  it('a relative GOAT_RUNNER_HOME is one line, exit 1', async () => {
    const res = await cli(['status'], { GOAT_RUNNER_HOME: 'relative/dir' });
    expect(res.code).toBe(1);
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).toContain('GOAT_RUNNER_HOME');
  });

  it('a revoked runner exits 1 and keeps its config', async () => {
    await linked({
      claim: (res) => sendJson(res, 401, { error: { code: 'unauthorized', message: 'no' } }),
    });
    const res = await cli(['run']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('This runner was revoked; link again.');
    expect(fs.existsSync(configFile())).toBe(true);
  });

  it('a revoked daemon exits 0 so systemd does not restart it', async () => {
    await linked({
      claim: (res) => sendJson(res, 401, { error: { code: 'unauthorized', message: 'no' } }),
    });
    const res = await cli(['run', '--daemon']);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(home, 'data', 'runner.log'), 'utf8')).toContain(
      'This runner was revoked; link again.',
    );
    expect(fs.existsSync(path.join(home, 'data', 'runner.pid'))).toBe(false);
  });

  async function runUntilClaiming(args: string[]) {
    await linked({
      claim: (res) => void setTimeout(() => sendJson(res, 200, { turn: null }), 100),
    });
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GOAT_RUNNER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdout?.resume();
    const exited = new Promise<number | null>((r) => child.on('close', r));
    const deadline = Date.now() + 15_000;
    while (!server!.requests.some((r) => r.path === '/runner/claim')) {
      if (Date.now() > deadline) throw new Error('the runner never claimed');
      await new Promise((r) => setTimeout(r, 50));
    }
    return { child, exited, stderr: () => stderr };
  }

  it.skipIf(!posix)('the foreground runner exits 0 on SIGTERM', async () => {
    const { child, exited, stderr } = await runUntilClaiming(['run']);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stderr()).not.toMatch(/ {4}at /);
  });

  it.skipIf(!posix)('--daemon exits 0 on SIGTERM and removes its pid file', async () => {
    const { child, exited } = await runUntilClaiming(['run', '--daemon']);
    const pidFile = path.join(home, 'data', 'runner.pid');
    expect(fs.existsSync(pidFile)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'data', 'runner.log'), 'utf8')).toContain('stopped');
  });

  it('--daemon exits 0 quietly when a live runner holds the pid file', async () => {
    await linked();
    const started = await startDaemon({
      cliPath: FAKE_DAEMON,
      dataDir: path.join(home, 'data'),
      env: { ...process.env, GOAT_RUNNER_HOME: home },
    });
    expect(started.running).toBe(true);
    const res = await cli(['run', '--daemon']);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    const foreground = await cli(['run']);
    expect(foreground.code).toBe(1);
    expect(foreground.stderr).toContain('A runner is already running; use goat-runner stop first.');
  });
});

describe('secrets', () => {
  it('no output of any command contains the credential', async () => {
    await linked();
    for (const args of [
      ['status'],
      ['status', '--json'],
      ['logs'],
      ['--help'],
      ['link', '--help'],
    ]) {
      await cli(args);
    }
    expect(everything.join('\n')).not.toContain(CREDENTIAL);
  });
});
