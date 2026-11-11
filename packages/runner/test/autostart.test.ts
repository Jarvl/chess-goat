import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autostartEnabled, autostartPlan, setAutostart, type RunFn } from '../src/autostart';

const lin = { nodePath: '/usr/bin/node', cliPath: '/opt/goat/cli.js', home: '/home/u' };
const mac = { nodePath: '/usr/bin/node', cliPath: '/opt/goat/cli.js', home: '/Users/u', uid: 501 };
const win = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliPath: 'C:\\Users\\u\\goat\\cli.js',
  home: 'C:\\Users\\u',
};

describe('autostartPlan snapshots', () => {
  it('linux', () => {
    expect(autostartPlan('linux', lin)).toMatchInlineSnapshot(`
      {
        "afterRemove": [
          [
            "systemctl",
            "--user",
            "daemon-reload",
          ],
        ],
        "describe": "a systemd user unit at /home/u/.config/systemd/user/goat-runner.service; remove it with systemctl --user disable goat-runner.service and delete that file",
        "disable": [
          [
            "systemctl",
            "--user",
            "disable",
            "goat-runner.service",
          ],
        ],
        "enable": [
          [
            "systemctl",
            "--user",
            "daemon-reload",
          ],
          [
            "systemctl",
            "--user",
            "enable",
            "goat-runner.service",
          ],
        ],
        "files": [
          {
            "content": "[Unit]
      Description=goat-runner (Chess Goat bot runner)

      [Service]
      Type=simple
      ExecStart="/usr/bin/node" "/opt/goat/cli.js" run --daemon
      Restart=on-failure
      RestartSec=30

      [Install]
      WantedBy=default.target
      ",
            "mode": 420,
            "path": "/home/u/.config/systemd/user/goat-runner.service",
          },
        ],
        "platform": "linux",
        "remove": [
          "/home/u/.config/systemd/user/goat-runner.service",
        ],
        "startsNow": false,
      }
    `);
  });
  it('linux with spaces, % and $', () => {
    const plan = autostartPlan('linux', {
      ...lin,
      nodePath: '/opt/my node/n%ode',
      cliPath: '/opt/c$li/a b.js',
    });
    expect(plan.files[0]!.content).toContain(
      'ExecStart="/opt/my node/n%%ode" "/opt/c$$li/a b.js" run --daemon\n',
    );
  });
  it('linux honours XDG_CONFIG_HOME and carries GOAT_RUNNER_HOME', () => {
    const plan = autostartPlan('linux', {
      ...lin,
      env: { XDG_CONFIG_HOME: '/x/cfg', GOAT_RUNNER_HOME: '/r h/%x' },
    });
    expect(plan.files[0]!.path).toBe('/x/cfg/systemd/user/goat-runner.service');
    expect(plan.files[0]!.content).toContain('Environment="GOAT_RUNNER_HOME=/r h/%%x"\n');
  });
  it('darwin', () => {
    expect(autostartPlan('darwin', mac)).toMatchInlineSnapshot(`
      {
        "afterRemove": [],
        "describe": "a LaunchAgent at /Users/u/Library/LaunchAgents/casa.glob.goat-runner.plist; remove it with launchctl bootout gui/501/casa.glob.goat-runner and delete that file",
        "disable": [
          [
            "launchctl",
            "bootout",
            "gui/501/casa.glob.goat-runner",
          ],
        ],
        "enable": [
          [
            "launchctl",
            "bootstrap",
            "gui/501",
            "/Users/u/Library/LaunchAgents/casa.glob.goat-runner.plist",
          ],
        ],
        "files": [
          {
            "content": "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>casa.glob.goat-runner</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/bin/node</string>
          <string>/opt/goat/cli.js</string>
          <string>run</string>
          <string>--daemon</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
          <key>SuccessfulExit</key>
          <false/>
        </dict>
        <key>ThrottleInterval</key>
        <integer>30</integer>
        <key>ProcessType</key>
        <string>Background</string>
      </dict>
      </plist>
      ",
            "mode": 420,
            "path": "/Users/u/Library/LaunchAgents/casa.glob.goat-runner.plist",
          },
        ],
        "platform": "darwin",
        "remove": [
          "/Users/u/Library/LaunchAgents/casa.glob.goat-runner.plist",
        ],
        "startsNow": true,
      }
    `);
  });
  it('darwin escapes XML and carries GOAT_RUNNER_HOME', () => {
    const plan = autostartPlan('darwin', {
      ...mac,
      nodePath: '/a b/n&de',
      cliPath: '/c<d>/cli.js',
      env: { GOAT_RUNNER_HOME: '/r&h' },
    });
    const c = plan.files[0]!.content;
    expect(c).toContain('<string>/a b/n&amp;de</string>');
    expect(c).toContain('<string>/c&lt;d&gt;/cli.js</string>');
    expect(c).toContain('<key>GOAT_RUNNER_HOME</key>\n    <string>/r&amp;h</string>');
  });
  it('win32', () => {
    expect(autostartPlan('win32', win)).toMatchInlineSnapshot(`
      {
        "afterRemove": [],
        "describe": "a Run entry named goat-runner under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run; remove it with reg delete in that key or in Settings > Apps > Startup",
        "disable": [
          [
            "C:\\Windows\\System32\\reg.exe",
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "goat-runner",
            "/f",
          ],
        ],
        "enable": [
          [
            "C:\\Windows\\System32\\reg.exe",
            "add",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "goat-runner",
            "/t",
            "REG_SZ",
            "/d",
            ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\goat\\cli.js" start",
            "/f",
          ],
        ],
        "files": [],
        "platform": "win32",
        "remove": [],
        "startsNow": false,
      }
    `);
  });
  it('win32 with spaces and a custom SystemRoot', () => {
    const plan = autostartPlan('win32', { ...win, env: { SystemRoot: 'D:\\Win' } });
    expect(plan.enable[0]![0]).toBe('D:\\Win\\System32\\reg.exe');
    expect(plan.enable[0]![8]).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\goat\\cli.js" start',
    );
  });
  it('win32 refuses GOAT_RUNNER_HOME, a double quote and an over-long command', () => {
    expect(() => autostartPlan('win32', { ...win, env: { GOAT_RUNNER_HOME: 'C:\\r' } })).toThrow(
      /GOAT_RUNNER_HOME/,
    );
    expect(() => autostartPlan('win32', { ...win, cliPath: 'C:\\a"b.js' })).toThrow(/double quote/);
    expect(() => autostartPlan('win32', { ...win, cliPath: `C:\\${'a'.repeat(250)}.js` })).toThrow(
      /260/,
    );
  });
});

describe('autostartPlan details', () => {
  const PATHV = '/home/u/.local/bin:/opt/my dir/%bin:/a&b';
  it('linux registers PATH and GOAT_RUNNER_HOME as two Environment lines', () => {
    const c = autostartPlan('linux', { ...lin, env: { PATH: PATHV, GOAT_RUNNER_HOME: '/r' } })
      .files[0]!.content;
    expect(c).toContain(
      'Environment="PATH=/home/u/.local/bin:/opt/my dir/%%bin:/a&b"\nEnvironment="GOAT_RUNNER_HOME=/r"\nExecStart=',
    );
  });
  it('linux writes no Environment line without PATH', () => {
    expect(autostartPlan('linux', { ...lin, env: { PATH: '' } }).files[0]!.content).not.toContain(
      'Environment=',
    );
  });
  it('linux escapes " and \\ in ExecStart arguments', () => {
    const plan = autostartPlan('linux', { ...lin, nodePath: '/a"b/node', cliPath: '/c\\d/cli.js' });
    expect(plan.files[0]!.content).toContain(
      'ExecStart="/a\\"b/node" "/c\\\\d/cli.js" run --daemon\n',
    );
  });
  it('linux unit has no After= and keeps daemon-reload for after the unit is removed', () => {
    const plan = autostartPlan('linux', lin);
    expect(plan.files[0]!.content).not.toContain('After=');
    expect(plan.disable).toEqual([['systemctl', '--user', 'disable', 'goat-runner.service']]);
    expect(plan.afterRemove).toEqual([['systemctl', '--user', 'daemon-reload']]);
  });
  it('darwin registers PATH and GOAT_RUNNER_HOME, XML-escaped, in one dict', () => {
    const c = autostartPlan('darwin', {
      ...mac,
      env: { PATH: PATHV, GOAT_RUNNER_HOME: '/r<h' },
    }).files[0]!.content;
    expect(c).toContain(
      '<key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/home/u/.local/bin:/opt/my dir/%bin:/a&amp;b</string>\n    <key>GOAT_RUNNER_HOME</key>\n    <string>/r&lt;h</string>\n  </dict>',
    );
    expect(autostartPlan('darwin', mac).files[0]!.content).not.toContain('EnvironmentVariables');
  });
  it('darwin plist is well-formed XML with balanced tags', () => {
    const c = autostartPlan('darwin', {
      ...mac,
      nodePath: '/a&b/<n>',
      env: { PATH: PATHV, GOAT_RUNNER_HOME: '/r&h' },
    }).files[0]!.content;
    const body = c.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
    // Text content may not hold a raw < or a bare &.
    expect(body.replace(/<[^>]+>/g, '')).not.toMatch(/<|&(?!(amp|lt|gt);)/);
    const stack: string[] = [];
    for (const m of body.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
      if (m[4]) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]!);
    }
    expect(stack).toEqual([]);
  });
  it('darwin keeps the job alive only after a crash', () => {
    const c = autostartPlan('darwin', mac).files[0]!.content;
    expect(c).toContain(
      '<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>',
    );
    expect(c).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
  });
  it('startsNow is true only on macOS', () => {
    expect(autostartPlan('darwin', mac).startsNow).toBe(true);
    expect(autostartPlan('linux', lin).startsNow).toBe(false);
    expect(autostartPlan('win32', win).startsNow).toBe(false);
  });
  it('win32 disable argv, and the registered command ends in start', () => {
    const plan = autostartPlan('win32', win);
    expect(plan.disable).toEqual([
      [
        'C:\\Windows\\System32\\reg.exe',
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'goat-runner',
        '/f',
      ],
    ]);
  });
  it('win32 accepts a command of exactly 260 characters and refuses 261', () => {
    const base = `"${win.nodePath}" "" start`.length;
    const make = (n: number) => `C:\\${'a'.repeat(n - base - 3)}`;
    expect(() => autostartPlan('win32', { ...win, cliPath: make(260) })).not.toThrow();
    expect(() => autostartPlan('win32', { ...win, cliPath: make(261) })).toThrow(/260/);
  });
  it.each(['linux', 'darwin', 'win32'] as const)('%s refuses CR, LF and NUL in any path', (pf) => {
    const base = pf === 'win32' ? win : pf === 'darwin' ? mac : lin;
    for (const bad of ['\r', '\n', '\0']) {
      expect(() => autostartPlan(pf, { ...base, nodePath: `/a${bad}b` })).toThrow(/line break/);
      expect(() => autostartPlan(pf, { ...base, cliPath: `/a${bad}b` })).toThrow(/line break/);
    }
  });
  it('macOS without a uid throws a clear Error', () => {
    expect(() => autostartPlan('darwin', { ...lin, home: '/Users/u' })).toThrow(/uid is required/);
  });
});

describe('setAutostart / autostartEnabled', () => {
  const skip = process.platform === 'win32';
  let home: string;
  let calls: string[][];
  const ok: RunFn = async (argv) => (calls.push(argv), { code: 0, output: '' });
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'autostart-'));
    calls = [];
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it.skipIf(skip)('on: writes the files, runs enable in order, reports enabled', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    expect(await autostartEnabled(plan)).toBe(false);
    const res = await setAutostart(true, plan, { run: ok });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(plan.enable);
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'goat-runner.service'],
    ]);
    expect(await readFile(plan.files[0]!.path, 'utf8')).toBe(plan.files[0]!.content);
    expect(await autostartEnabled(plan)).toBe(true);
  });

  it.skipIf(skip)(
    'a failing second command rolls back and reports the cleaned first line',
    async () => {
      const plan = autostartPlan('linux', { ...lin, home });
      let n = 0;
      const run: RunFn = async () =>
        ++n === 2
          ? { code: 1, output: `\n\u001b[31mFailed to connect to bus\u0007\nsecond line` }
          : { code: 0, output: '' };
      const res = await setAutostart(true, plan, { run });
      expect(res).toEqual({ ok: false, detail: 'systemctl failed: [31mFailed to connect to bus' });
      expect(await autostartEnabled(plan)).toBe(false);
    },
  );

  it.skipIf(skip)('ENOENT says the program is not available', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    const run: RunFn = async () => {
      throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
    };
    expect(await setAutostart(true, plan, { run })).toEqual({
      ok: false,
      detail: 'systemctl is not available on this machine',
    });
    expect(await autostartEnabled(plan)).toBe(false);
  });

  it.skipIf(skip)('off: runs disable, ignores its failure, deletes the files', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    await setAutostart(true, plan, { run: ok });
    calls = [];
    const run: RunFn = async (argv) => {
      calls.push(argv);
      throw new Error('boom');
    };
    expect((await setAutostart(false, plan, { run })).ok).toBe(true);
    expect(calls).toEqual([...plan.disable, ...plan.afterRemove]);
    await expect(stat(plan.files[0]!.path)).rejects.toThrow();
    // Turning off when nothing is registered is fine too.
    expect((await setAutostart(false, plan, { run: ok })).ok).toBe(true);
  });

  it.skipIf(skip)('macOS: turning on twice runs bootout before bootstrap', async () => {
    const plan = autostartPlan('darwin', { ...mac, home });
    await setAutostart(true, plan, { run: ok });
    await setAutostart(true, plan, { run: ok });
    const bootout = ['launchctl', 'bootout', 'gui/501/casa.glob.goat-runner'];
    const bootstrap = ['launchctl', 'bootstrap', 'gui/501', plan.files[0]!.path];
    expect(calls).toEqual([bootout, bootstrap, bootout, bootstrap]);
  });

  it.skipIf(skip)('a timed-out command reports the timeout', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    const run: RunFn = async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    };
    expect(await setAutostart(true, plan, { run })).toEqual({
      ok: false,
      detail: 'systemctl timed out after 15 s',
    });
    expect(await autostartEnabled(plan)).toBe(false);
  });

  it.skipIf(skip)('macOS retries bootstrap once after a wait, then succeeds', async () => {
    const plan = autostartPlan('darwin', { ...mac, home });
    const sleeps: number[] = [];
    let bootstraps = 0;
    const run: RunFn = async (argv) => {
      calls.push(argv);
      if (argv[1] === 'bootstrap' && ++bootstraps === 1) {
        return { code: 5, output: 'Bootstrap failed: 5: Input/output error\n' };
      }
      return { code: 0, output: '' };
    };
    const res = await setAutostart(true, plan, { run, sleep: async (ms) => void sleeps.push(ms) });
    expect(res.ok).toBe(true);
    expect(sleeps).toEqual([1000]);
    expect(calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
    expect(await autostartEnabled(plan)).toBe(true);
  });

  it.skipIf(skip)('macOS gives up after the second failed bootstrap and rolls back', async () => {
    const plan = autostartPlan('darwin', { ...mac, home });
    const sleeps: number[] = [];
    const run: RunFn = async (argv) => {
      calls.push(argv);
      return argv[1] === 'bootstrap'
        ? { code: 5, output: 'Bootstrap failed: 5: Input/output error\n' }
        : { code: 0, output: '' };
    };
    const res = await setAutostart(true, plan, { run, sleep: async (ms) => void sleeps.push(ms) });
    expect(res).toEqual({
      ok: false,
      detail: 'launchctl failed: Bootstrap failed: 5: Input/output error',
    });
    expect(calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(await autostartEnabled(plan)).toBe(false);
  });

  it.skipIf(skip)('linux does not retry a failing command', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    const run: RunFn = async (argv) => (calls.push(argv), { code: 1, output: 'x' });
    await setAutostart(true, plan, { run, sleep: async () => expect.fail('no wait expected') });
    expect(calls).toHaveLength(1);
  });

  it.skipIf(skip)('off on linux reloads systemd after the unit file is gone', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    await setAutostart(true, plan, { run: ok });
    calls = [];
    let existedAtReload: boolean | undefined;
    const run: RunFn = async (argv) => {
      calls.push(argv);
      if (argv[2] === 'daemon-reload') {
        existedAtReload = await stat(plan.files[0]!.path).then(
          () => true,
          () => false,
        );
      }
      return { code: 0, output: '' };
    };
    await setAutostart(false, plan, { run });
    expect(calls.map((c) => c[2])).toEqual(['disable', 'daemon-reload']);
    expect(existedAtReload).toBe(false);
  });

  it.skipIf(skip)('a file whose parent is a regular file gives ok:false, not a throw', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    const blocker = path.dirname(path.dirname(path.dirname(plan.files[0]!.path)));
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, 'x');
    const res = await setAutostart(true, plan, { run: ok });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toBe('');
    expect(calls).toEqual([]);
  });

  it.skipIf(skip)('a file that cannot be written gives ok:false and is rolled back', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    // The target is a directory, so the write fails; an earlier file of the plan is removed.
    const first = path.join(home, 'first.txt');
    await mkdir(plan.files[0]!.path, { recursive: true });
    const two = {
      ...plan,
      files: [{ path: first, content: 'a' }, plan.files[0]!],
    };
    const res = await setAutostart(true, two, { run: ok });
    expect(res.ok).toBe(false);
    await expect(stat(first)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('windows: enabled follows reg query through the injected run', async () => {
    const plan = autostartPlan('win32', win);
    const seen: string[][] = [];
    expect(
      await autostartEnabled(plan, { run: async (a) => (seen.push(a), { code: 0, output: '' }) }),
    ).toBe(true);
    expect(seen).toEqual([
      [
        'C:\\Windows\\System32\\reg.exe',
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'goat-runner',
      ],
    ]);
    expect(await autostartEnabled(plan, { run: async () => ({ code: 1, output: '' }) })).toBe(
      false,
    );
  });

  it('the default runner really runs a program and reports its exit code', async () => {
    const plan = autostartPlan('linux', { ...lin, home });
    const withEnable = (argv: string[][]) => ({ ...plan, files: [], enable: argv });
    expect(
      await setAutostart(true, withEnable([[process.execPath, '-e', 'process.exit(0)']])),
    ).toMatchObject({ ok: true });
    const res = await setAutostart(
      true,
      withEnable([[process.execPath, '-e', 'console.error("nope");process.exit(3)']]),
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/nope$/);
    expect((await setAutostart(true, withEnable([['goat-no-such-program-xyz']]))).detail).toBe(
      'goat-no-such-program-xyz is not available on this machine',
    );
  });
});
