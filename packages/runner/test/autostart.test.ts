import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
        "describe": "a systemd user unit at /home/u/.config/systemd/user/goat-runner.service",
        "disable": [
          [
            "systemctl",
            "--user",
            "disable",
            "goat-runner.service",
          ],
          [
            "systemctl",
            "--user",
            "daemon-reload",
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
      After=network-online.target

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
        "describe": "a LaunchAgent at /Users/u/Library/LaunchAgents/casa.glob.goat-runner.plist",
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
        <false/>
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
        "describe": "a scheduled task named goat-runner that runs at logon",
        "disable": [
          [
            "C:\\Windows\\System32\\schtasks.exe",
            "/Delete",
            "/TN",
            "goat-runner",
            "/F",
          ],
        ],
        "enable": [
          [
            "C:\\Windows\\System32\\schtasks.exe",
            "/Create",
            "/SC",
            "ONLOGON",
            "/TN",
            "goat-runner",
            "/TR",
            ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\goat\\cli.js" run --daemon",
            "/RL",
            "LIMITED",
            "/F",
          ],
        ],
        "files": [],
        "platform": "win32",
        "remove": [],
      }
    `);
  });
  it('win32 with spaces and a custom SystemRoot', () => {
    const plan = autostartPlan('win32', { ...win, env: { SystemRoot: 'D:\\Win' } });
    expect(plan.enable[0]![0]).toBe('D:\\Win\\System32\\schtasks.exe');
    expect(plan.enable[0]![7]).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\goat\\cli.js" run --daemon',
    );
  });
  it('win32 refuses GOAT_RUNNER_HOME, a double quote and an over-long command', () => {
    expect(() => autostartPlan('win32', { ...win, env: { GOAT_RUNNER_HOME: 'C:\\r' } })).toThrow(
      /GOAT_RUNNER_HOME/,
    );
    expect(() => autostartPlan('win32', { ...win, cliPath: 'C:\\a"b.js' })).toThrow(/double quote/);
    expect(() => autostartPlan('win32', { ...win, cliPath: `C:\\${'a'.repeat(250)}.js` })).toThrow(
      /261/,
    );
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
    expect(calls).toEqual(plan.disable);
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

  it('windows: enabled follows schtasks /Query through the injected run', async () => {
    const plan = autostartPlan('win32', win);
    const seen: string[][] = [];
    expect(
      await autostartEnabled(plan, { run: async (a) => (seen.push(a), { code: 0, output: '' }) }),
    ).toBe(true);
    expect(seen).toEqual([['C:\\Windows\\System32\\schtasks.exe', '/Query', '/TN', 'goat-runner']]);
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
