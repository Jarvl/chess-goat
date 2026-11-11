import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { AlreadyRunningError } from '../src/daemon.js';
import { main } from '../src/commands/index.js';
import { fakeContext, type Fake } from './support/ctx.js';
import { CREDENTIAL, GOOD_CODE, runnerServer } from './support/linkServer.js';
import type { TestServer } from './support/httpServer.js';

let fake: Fake;
let server: TestServer | undefined;
afterEach(async () => {
  fake?.cleanup();
  await server?.close();
  server = undefined;
});

const configOf = () => readConfig(path.join(fake.home, 'config'));
const noTrace = () => expect(fake.err()).not.toMatch(/ {4}at /);

async function linkWith(
  args: string[],
  serverOpts: Parameters<typeof runnerServer>[0] = {},
  ctxOpts: Parameters<typeof fakeContext>[0] = {},
) {
  fake = fakeContext(ctxOpts);
  server = await runnerServer(serverOpts);
  const code = await main(['link', GOOD_CODE, '--server', server.url, ...args], fake.ctx);
  return code;
}

describe('link', () => {
  it('enables autostart before it starts the runner', async () => {
    expect(await linkWith(['--preset', 'claude', '--json'])).toBe(0);
    expect(fake.calls).toEqual(['autostart on', 'start']);
    expect(JSON.parse(fake.out())).toEqual({
      linked: true,
      runner_id: 7,
      preset: 'claude',
      started: true,
      autostart: true,
      autostart_detail: 'a fake unit',
    });
  });

  it('does not start a second runner when the autostart plan starts one itself', async () => {
    expect(await linkWith(['--preset', 'claude', '--json'], {}, { startsNow: true })).toBe(0);
    expect(fake.calls).toEqual(['autostart on']);
    expect(JSON.parse(fake.out()).started).toBe(true);
  });

  it('still starts it itself when autostart failed, even on a startsNow plan', async () => {
    expect(
      await linkWith(['--preset', 'claude', '--json'], {}, { startsNow: true, autostartOk: false }),
    ).toBe(0);
    expect(fake.calls).toEqual(['autostart on', 'start']);
  });

  it('an autostart failure is not a link failure', async () => {
    expect(await linkWith(['--preset', 'claude', '--json'], {}, { autostartOk: false })).toBe(0);
    const out = JSON.parse(fake.out());
    expect(out.autostart).toBe(false);
    expect(out.autostart_detail).toContain('not available');
    expect(out.started).toBe(true);
    expect(configOf()?.runnerId).toBe(7);
  });

  it('--no-autostart and --no-start do what they say', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-autostart', '--no-start', '--json'])).toBe(
      0,
    );
    expect(fake.calls).toEqual([]);
    expect(JSON.parse(fake.out())).toMatchObject({ started: false, autostart: false });
  });

  it('warns once on stderr for claude, which is unverified but not gated', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'])).toBe(0);
    expect(fake.err().trim().split('\n')).toHaveLength(1);
    expect(fake.err()).toContain('unverified');
  });

  it('refuses codex without --allow-unverified, before using the code', async () => {
    expect(await linkWith(['--preset', 'codex'])).toBe(2);
    expect(fake.err()).toContain('--allow-unverified');
    expect(fake.err()).toContain('built-in shell tool');
    expect(server!.requests).toHaveLength(0);
    expect(configOf()).toBeNull();
    noTrace();
  });

  it('accepts codex with --allow-unverified', async () => {
    expect(
      await linkWith(['--preset', 'codex', '--allow-unverified', '--no-start', '--no-autostart']),
    ).toBe(0);
    expect(configOf()?.preset).toBe('codex');
    expect(fake.err()).toContain('unverified');
  });

  it('keeps the credential when the server-stored preset is refused after redeeming', async () => {
    expect(await linkWith(['--json'], { preset: 'goose' })).toBe(2);
    expect(fake.err()).toContain('--allow-unverified');
    expect(fake.err()).toContain('Linked as runner 7');
    expect(fake.err()).toContain('goat-runner preset <name>');
    expect(configOf()).toMatchObject({ runnerId: 7, credential: CREDENTIAL, preset: 'claude' });
    expect(fake.calls).toEqual([]);
    expect(JSON.parse(fake.out())).toMatchObject({
      started: false,
      autostart: false,
      needs_preset: true,
    });
  });

  it('keeps the credential when the server preset needs flags that were not given', async () => {
    expect(await linkWith([], { preset: 'lean' })).toBe(2);
    expect(fake.err()).toContain('--lean-base-url');
    expect(configOf()?.runnerId).toBe(7);
    expect(fake.calls).toEqual([]);
  });

  it('names a flag that belongs to another preset, before redeeming', async () => {
    expect(await linkWith(['--preset', 'claude', '--lean-model', 'm'])).toBe(2);
    expect(fake.err()).toContain('lean preset, not claude');
    expect(server!.requests).toHaveLength(0);
  });

  it('exits 1 with one sentence when the config cannot be saved, starting nothing', async () => {
    expect(
      await linkWith(
        ['--preset', 'claude'],
        {},
        {
          writeConfig: () => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          },
        },
      ),
    ).toBe(1);
    expect(fake.err()).toContain('Linked as runner 7 but could not save the link (EACCES');
    expect(fake.err()).toContain('The link code is used up');
    expect(fake.calls).toEqual([]);
  });

  it('uses the server preset, then the detected one, then exits 2 listing the choices', async () => {
    expect(await linkWith(['--no-start', '--no-autostart'], { preset: 'claude' })).toBe(0);
    expect(configOf()?.preset).toBe('claude');
    server = undefined;
    expect(await linkWith(['--no-start', '--no-autostart'], {}, { detect: 'claude' })).toBe(0);
    expect(await linkWith(['--no-start', '--no-autostart'], {}, { detect: null })).toBe(2);
    expect(fake.err()).toContain('claude, codex, opencode, goose, lean, custom');
    expect(configOf()?.runnerId).toBe(7); // saved with a placeholder, nothing started
    expect(fake.calls).toEqual([]);
  });

  it('lean and custom take their settings from flags', async () => {
    expect(await linkWith(['--preset', 'lean', '--no-start', '--no-autostart'])).toBe(2);
    expect(fake.err()).toContain('--lean-base-url');
    expect(
      await linkWith([
        '--preset',
        'lean',
        '--lean-base-url',
        'http://127.0.0.1:11434/v1',
        '--lean-model',
        'm',
        '--no-start',
        '--no-autostart',
      ]),
    ).toBe(0);
    expect(configOf()?.lean).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' });
    expect(
      await linkWith([
        '--preset',
        'custom',
        '--custom-command',
        'my-agent',
        '--custom-arg=--x',
        '--custom-arg=y',
        '--no-start',
        '--no-autostart',
      ]),
    ).toBe(0);
    expect(configOf()?.custom).toEqual({ command: 'my-agent', args: ['--x', 'y'] });
  });

  it('stops the old runner before it replaces the config', async () => {
    fake = fakeContext();
    server = await runnerServer();
    fake.daemon.running = true;
    const code = await main(
      ['link', GOOD_CODE, '--server', server.url, '--preset', 'claude', '--no-autostart'],
      fake.ctx,
    );
    expect(code).toBe(0);
    expect(fake.calls).toEqual(['stop', 'start']);
  });

  it('writes the config but fails when the old runner will not stop', async () => {
    fake = fakeContext({ stopWorks: false });
    server = await runnerServer();
    fake.daemon.running = true;
    const code = await main(
      ['link', GOOD_CODE, '--server', server.url, '--preset', 'claude', '--no-autostart'],
      fake.ctx,
    );
    expect(code).toBe(1);
    expect(fake.err()).toContain('would not stop');
    expect(configOf()?.credential).toBe(CREDENTIAL);
  });

  it('refuses a plain http server that is not this machine, with the config sentence', async () => {
    fake = fakeContext();
    const code = await main(
      ['link', 'x', '--server', 'http://example.com', '--preset', 'claude'],
      fake.ctx,
    );
    expect(code).toBe(1);
    expect(fake.err()).toContain('the server address must use https');
    expect(fake.err().trim().split('\n')).toHaveLength(1);
  });

  it('a missing --server is a usage error', async () => {
    fake = fakeContext();
    expect(await main(['link', 'x'], fake.ctx)).toBe(2);
    expect(fake.err()).toContain('Usage: goat-runner link');
  });
});

describe('start and stop', () => {
  it('start reports an already running daemon as success', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'])).toBe(0);
    fake.daemon.running = true;
    const before = fake.out().length;
    expect(await main(['start', '--json'], fake.ctx)).toBe(0);
    expect(JSON.parse(fake.out().slice(before))).toMatchObject({ started: false, running: true });
    expect(fake.calls).not.toContain('start');
  });

  it('start says so when the running runner predates the last link', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'])).toBe(0);
    fake.daemon.running = true;
    fake.daemon.since = '2000-01-01T00:00:00.000Z';
    const before = fake.out().length;
    expect(await main(['start', '--json'], fake.ctx)).toBe(1);
    expect(JSON.parse(fake.out().slice(before))).toEqual({
      started: false,
      running: true,
      stale: true,
    });
    expect(fake.err()).toContain('goat-runner stop, then goat-runner start');
  });

  it('start without a link exits 1', async () => {
    fake = fakeContext();
    expect(await main(['start'], fake.ctx)).toBe(1);
    expect(fake.err()).toContain('Not linked.');
  });

  it('stop with nothing running exits 0 and says so', async () => {
    fake = fakeContext();
    expect(await main(['stop'], fake.ctx)).toBe(0);
    expect(fake.out()).toContain('was not running');
    expect(fake.calls).toEqual([]);
  });

  it('stop exits 1 only when it could not stop', async () => {
    fake = fakeContext({ stopWorks: false });
    fake.daemon.running = true;
    expect(await main(['stop'], fake.ctx)).toBe(1);
    expect(fake.err()).toContain('Could not stop');
    noTrace();
  });
});

describe('run', () => {
  async function linked(ctxOpts: Parameters<typeof fakeContext>[0] = {}) {
    await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'], {}, ctxOpts);
  }

  it('--daemon exits 0 quietly when another runner holds the pid file', async () => {
    await linked({
      claim: () => {
        throw new AlreadyRunningError();
      },
    });
    const before = fake.err().length;
    expect(await main(['run', '--daemon'], fake.ctx)).toBe(0);
    expect(fake.err().slice(before)).toBe('');
  });

  it('foreground refuses to run beside a live runner', async () => {
    await linked({
      claim: () => {
        throw new AlreadyRunningError();
      },
    });
    expect(await main(['run'], fake.ctx)).toBe(1);
    expect(fake.err()).toContain('A runner is already running; use goat-runner stop first.');
  });

  it('foreground holds the pid file and releases it', async () => {
    await linked();
    expect(await main(['run'], fake.ctx)).toBe(0);
    expect(fake.calls).toEqual(['claim pid', 'release pid']);
  });

  it('refuses --json', async () => {
    await linked();
    expect(await main(['run', '--json'], fake.ctx)).toBe(2);
    expect(fake.err()).toContain('Usage: goat-runner run');
  });

  it('a revoked daemon exits 0 (no restart loop); the foreground exits 1', async () => {
    await linked({ runLoop: async () => 'revoked' });
    expect(await main(['run', '--daemon'], fake.ctx)).toBe(0);
  });

  it('--daemon releases its pid file on exit, and exits 0 when stopped by a signal', async () => {
    await linked({
      runLoop: async (_deps, signal) => {
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        return 'stopped';
      },
    });
    const done = main(['run', '--daemon'], fake.ctx);
    await new Promise((r) => setTimeout(r, 50));
    fake.signals.fire();
    expect(await done).toBe(0);
    expect(fake.calls).toContain('release pid');
  });

  it('a second signal exits at once', async () => {
    await linked({ runLoop: () => new Promise(() => {}) });
    void main(['run'], fake.ctx);
    await new Promise((r) => setTimeout(r, 50));
    fake.signals.fire();
    expect(() => fake.signals.fire()).toThrow('exit 1');
  });

  it('a revoked runner exits 1 with the sentence and removes nothing', async () => {
    await linked({ runLoop: async () => 'revoked' });
    expect(await main(['run'], fake.ctx)).toBe(1);
    expect(fake.err()).toContain('This runner was revoked; link again.');
    expect(configOf()).not.toBeNull();
  });

  it('without a link exits 1', async () => {
    fake = fakeContext();
    expect(await main(['run'], fake.ctx)).toBe(1);
    expect(fake.err().trim()).toBe(
      'Not linked. Ask your agent to call link_runner and run the command it gives.',
    );
  });
});

describe('autostart and unlink', () => {
  it('autostart on needs a link; off does not', async () => {
    fake = fakeContext();
    expect(await main(['autostart', 'on'], fake.ctx)).toBe(1);
    expect(await main(['autostart', 'off'], fake.ctx)).toBe(0);
    expect(await main(['autostart', 'sideways'], fake.ctx)).toBe(2);
  });

  it('unlink stops, removes autostart and the config, and says the server still lists it', async () => {
    await linkWith(['--preset', 'claude'], {});
    expect(await main(['unlink'], fake.ctx)).toBe(0);
    expect(fake.calls.slice(-2)).toEqual(['stop', 'autostart off']);
    expect(configOf()).toBeNull();
    expect(fake.out()).toContain('revoke_runner');
    expect(fake.out()).toContain('Mini App');
  });
});

describe('output', () => {
  it('cleans control characters that come from the config or the server', async () => {
    await linkWith(['--preset', 'claude', '--no-start', '--no-autostart']);
    expect(await main(['status'], fake.ctx)).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(fake.out()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });

  it('never prints the credential, in any command', async () => {
    await linkWith(['--preset', 'claude']);
    for (const args of [
      ['status'],
      ['status', '--json'],
      ['logs'],
      ['--help'],
      ['link', '--help'],
      ['unlink'],
    ]) {
      await main(args, fake.ctx);
    }
    expect(fake.out() + fake.err()).not.toContain(CREDENTIAL);
    expect(fake.out() + fake.err()).not.toContain('cgrun_');
  });
});

describe('preset', () => {
  async function linkedClaude(ctxOpts: Parameters<typeof fakeContext>[0] = {}) {
    expect(
      await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'], {}, ctxOpts),
    ).toBe(0);
  }

  it('without a link exits 1', async () => {
    fake = fakeContext();
    expect(await main(['preset', 'claude'], fake.ctx)).toBe(1);
    expect(fake.err()).toContain('Not linked.');
  });

  it('refuses codex without --allow-unverified and accepts it with', async () => {
    await linkedClaude();
    expect(await main(['preset', 'codex'], fake.ctx)).toBe(2);
    expect(fake.err()).toContain('--allow-unverified');
    expect(configOf()?.preset).toBe('claude');
    expect(await main(['preset', 'codex', '--allow-unverified', '--json'], fake.ctx)).toBe(0);
    expect(configOf()?.preset).toBe('codex');
    expect(configOf()?.credential).toBe(CREDENTIAL);
    expect(fake.out()).toContain('{"preset":"codex","restarted":false}');
  });

  it('replaces the lean section, and restarts a running runner', async () => {
    await linkedClaude();
    fake.daemon.running = true;
    const lean = ['--lean-base-url', 'http://127.0.0.1:1/v1', '--lean-model', 'm'];
    expect(await main(['preset', 'lean', ...lean, '--json'], fake.ctx)).toBe(0);
    expect(configOf()?.lean?.model).toBe('m');
    expect(fake.calls.slice(-2)).toEqual(['stop', 'start']);
    expect(await main(['preset', 'claude'], fake.ctx)).toBe(0);
    expect(configOf()?.lean).toBeUndefined();
  });

  it('a placeholder link is fixed by preset', async () => {
    expect(await linkWith([], { preset: 'goose' })).toBe(2);
    expect(await main(['preset', 'goose', '--allow-unverified'], fake.ctx)).toBe(0);
    expect(configOf()).toMatchObject({ preset: 'goose', runnerId: 7 });
    expect(fake.out()).toContain('The background runner is running.');
  });
});

describe('a link without a harness', () => {
  const SENTENCE = 'No harness is chosen yet. Choose one with: goat-runner preset <name>';

  it('stops the old runner, marks the config, and refuses start, run and autostart on', async () => {
    let loops = 0;
    fake = fakeContext({
      runLoop: async () => {
        loops++;
        return 'stopped';
      },
    });
    server = await runnerServer({ preset: 'goose' });
    fake.daemon.running = true; // an old runner, with autostart already enabled
    expect(await main(['link', GOOD_CODE, '--server', server.url], fake.ctx)).toBe(2);
    expect(fake.daemon.running).toBe(false);
    expect(fake.calls).toEqual(['stop']);
    expect(
      JSON.parse(fs.readFileSync(path.join(fake.home, 'config', 'config.json'), 'utf8')),
    ).toMatchObject({
      needsPreset: true,
      runnerId: 7,
    });
    const before = fake.err().length;
    for (const args of [['start'], ['run'], ['autostart', 'on']]) {
      expect(await main(args, fake.ctx)).toBe(2);
    }
    expect(fake.err().slice(before).split(SENTENCE).length - 1).toBe(3);
    expect(await main(['run', '--daemon'], fake.ctx)).toBe(0);
    expect(fake.calls).toContain(`log: ${SENTENCE}`);
    expect(loops).toBe(0);
    expect(fake.calls).not.toContain('start');
    expect(fake.calls).not.toContain('autostart on');
    await main(['status', '--json'], fake.ctx);
    expect(fake.out()).toContain('"needs_preset":true');
  });

  it('says so when the previous runner would not stop', async () => {
    fake = fakeContext({ stopWorks: false });
    server = await runnerServer({ preset: 'goose' });
    fake.daemon.running = true;
    expect(await main(['link', GOOD_CODE, '--server', server.url], fake.ctx)).toBe(2);
    expect(fake.err()).toContain('the previous runner would not stop; run goat-runner stop.');
    expect(fake.err()).not.toContain('Nothing is running yet');
  });

  it('preset on a marked config enables autostart, then starts, and clears the marker', async () => {
    expect(await linkWith([], { preset: 'goose' })).toBe(2);
    fake.calls.length = 0;
    expect(await main(['preset', 'claude', '--json'], fake.ctx)).toBe(0);
    expect(fake.calls).toEqual(['autostart on', 'start']);
    expect(configOf()?.needsPreset).toBeUndefined();
    expect(JSON.parse(fake.out().split('\n').filter(Boolean).pop()!)).toEqual({
      preset: 'claude',
      restarted: false,
      started: true,
      autostart: true,
      autostart_detail: 'a fake unit',
    });
    expect(await main(['start'], fake.ctx)).toBe(0);
  });

  it('preset on a marked config honours --no-autostart and --no-start', async () => {
    expect(await linkWith([], { preset: 'goose' })).toBe(2);
    fake.calls.length = 0;
    expect(await main(['preset', 'claude', '--no-autostart', '--no-start'], fake.ctx)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('preset on an unmarked config never touches autostart', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'])).toBe(0);
    fake.calls.length = 0;
    expect(await main(['preset', 'claude'], fake.ctx)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('start does not call a daemon started after the config stale', async () => {
    expect(await linkWith(['--preset', 'claude', '--no-start', '--no-autostart'])).toBe(0);
    fake.daemon.running = true; // since is in the future: started after the config was written
    expect(await main(['start'], fake.ctx)).toBe(0);
    expect(fake.out()).toContain('already running');
  });
});
