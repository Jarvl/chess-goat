import spawn from 'cross-spawn';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Platform } from './paths.js';

export type AutostartPlan = {
  platform: Platform;
  files: { path: string; content: string; mode?: number }[];
  /** argv arrays (program first), run in order with no shell. */
  enable: string[][];
  disable: string[][];
  /** Files deleted when turning off. */
  remove: string[];
  /** One sentence saying what is registered. */
  describe: string;
};
export type RunFn = (argv: string[]) => Promise<{ code: number | null; output: string }>;

const LABEL = 'casa.glob.goat-runner';
const UNIT = 'goat-runner.service';
const TASK = 'goat-runner';
const SCHTASKS_TR_LIMIT = 261;
const COMMAND_TIMEOUT_MS = 15_000;
const DETAIL_CHARS = 200;

const pathFor = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// systemd expands %specifiers and $VARS in ExecStart; both are escaped by doubling.
const unitArg = (s: string) =>
  `"${s.replace(/[\\"]/g, '\\$&').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
const unitEnv = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

export function autostartPlan(
  platform: Platform,
  opts: { nodePath: string; cliPath: string; home: string; uid?: number; env?: NodeJS.ProcessEnv },
): AutostartPlan {
  const { nodePath, cliPath, home } = opts;
  const env = opts.env ?? {};
  const p = pathFor(platform);
  const runHome = env.GOAT_RUNNER_HOME || undefined;
  // A line break would end the setting early in a unit or plist; no platform wants one here.
  for (const v of [nodePath, cliPath, runHome ?? '']) {
    if (/[\r\n\0]/.test(v)) throw new Error('a path with a line break cannot be registered');
  }

  if (platform === 'darwin') {
    if (opts.uid === undefined) throw new Error('uid is required on macOS');
    const plist = p.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const args = [nodePath, cliPath, 'run', '--daemon'];
    const envBlock = runHome
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>GOAT_RUNNER_HOME</key>\n    <string>${xml(runHome)}</string>\n  </dict>\n`
      : '';
    const content =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n<dict>\n` +
      `  <key>Label</key>\n  <string>${LABEL}</string>\n` +
      `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>\n` +
      envBlock +
      `  <key>RunAtLoad</key>\n  <true/>\n` +
      `  <key>KeepAlive</key>\n  <false/>\n` +
      `  <key>ProcessType</key>\n  <string>Background</string>\n` +
      `</dict>\n</plist>\n`;
    const domain = `gui/${opts.uid}`;
    return {
      platform,
      files: [{ path: plist, content, mode: 0o644 }],
      enable: [['launchctl', 'bootstrap', domain, plist]],
      disable: [['launchctl', 'bootout', `${domain}/${LABEL}`]],
      remove: [plist],
      describe: `a LaunchAgent at ${plist}`,
    };
  }

  if (platform === 'linux') {
    const base =
      env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : p.join(home, '.config');
    const unit = p.join(base, 'systemd', 'user', UNIT);
    const content =
      `[Unit]\nDescription=goat-runner (Chess Goat bot runner)\nAfter=network-online.target\n\n` +
      `[Service]\nType=simple\n` +
      (runHome ? `Environment=${unitEnv(`GOAT_RUNNER_HOME=${runHome}`)}\n` : '') +
      `ExecStart=${unitArg(nodePath)} ${unitArg(cliPath)} run --daemon\n` +
      `Restart=on-failure\nRestartSec=30\n\n` +
      `[Install]\nWantedBy=default.target\n`;
    return {
      platform,
      files: [{ path: unit, content, mode: 0o644 }],
      // No --now: the caller starts the background process itself, and it must not start twice.
      enable: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', UNIT],
      ],
      disable: [
        ['systemctl', '--user', 'disable', UNIT],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      remove: [unit],
      describe: `a systemd user unit at ${unit}`,
    };
  }

  // Windows: a scheduled task, no file.
  // Quoting through cmd.exe /c with nested quotes is not something we can verify here, so refuse.
  if (runHome) {
    throw new Error(
      'start at login cannot carry GOAT_RUNNER_HOME on Windows; unset it or start the runner yourself',
    );
  }
  if (nodePath.includes('"') || cliPath.includes('"')) {
    throw new Error('a path containing a double quote cannot be registered as a scheduled task');
  }
  const command = `"${nodePath}" "${cliPath}" run --daemon`;
  if (command.length > SCHTASKS_TR_LIMIT) {
    throw new Error(
      `the command line is ${command.length} characters; schtasks allows at most ${SCHTASKS_TR_LIMIT}`,
    );
  }
  const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
  return {
    platform,
    files: [],
    enable: [
      [exe, '/Create', '/SC', 'ONLOGON', '/TN', TASK, '/TR', command, '/RL', 'LIMITED', '/F'],
    ],
    disable: [[exe, '/Delete', '/TN', TASK, '/F']],
    remove: [],
    describe: `a scheduled task named ${TASK} that runs at logon`,
  };
}

const defaultRun: RunFn = (argv) =>
  new Promise((resolve, reject) => {
    const [program, ...args] = argv;
    const child = spawn(program!, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const take = (d: Buffer) => {
      if (output.length < 4096) output += d.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

// First non-empty line, control characters dropped, bounded.
const firstLine = (output: string): string =>
  (output.split(/\r?\n/).find((l) => l.trim()) ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, DETAIL_CHARS);

const programName = (argv: string[]) => path.basename(argv[0]!.replace(/\\/g, '/'));

export async function setAutostart(
  on: boolean,
  plan: AutostartPlan,
  opts: { run?: RunFn } = {},
): Promise<{ ok: boolean; detail: string }> {
  const run = opts.run ?? defaultRun;
  try {
    if (!on) {
      for (const argv of plan.disable) await run(argv).catch(() => undefined);
      let failed: string | undefined;
      for (const file of plan.remove) {
        try {
          await rm(file, { force: true });
        } catch (e) {
          failed ??= `could not delete ${file}: ${(e as Error).message}`;
        }
      }
      return failed
        ? { ok: false, detail: failed.slice(0, DETAIL_CHARS) }
        : { ok: true, detail: 'removed' };
    }

    // launchd refuses to bootstrap a label that is already loaded.
    if (plan.platform === 'darwin') {
      for (const argv of plan.disable) await run(argv).catch(() => undefined);
    }
    const written: string[] = [];
    const rollback = () =>
      Promise.all(written.map((f) => rm(f, { force: true }).catch(() => undefined)));
    for (const f of plan.files) {
      await mkdir(path.dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode ?? 0o644 });
      written.push(f.path);
    }
    for (const argv of plan.enable) {
      const name = programName(argv);
      let res: { code: number | null; output: string };
      try {
        res = await run(argv);
      } catch (e) {
        await rollback();
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        return {
          ok: false,
          detail: missing
            ? `${name} is not available on this machine`
            : `${name} failed: ${firstLine((e as Error).message)}`.slice(
                0,
                DETAIL_CHARS + name.length + 9,
              ),
        };
      }
      if (res.code !== 0) {
        await rollback();
        return { ok: false, detail: `${name} failed: ${firstLine(res.output)}` };
      }
    }
    return { ok: true, detail: plan.describe };
  } catch (e) {
    return { ok: false, detail: firstLine((e as Error).message) || 'start at login failed' };
  }
}

export async function autostartEnabled(
  plan: AutostartPlan,
  opts: { run?: RunFn } = {},
): Promise<boolean> {
  if (plan.platform === 'win32') {
    const exe = plan.disable[0]?.[0];
    if (!exe) return false;
    try {
      return (await (opts.run ?? defaultRun)([exe, '/Query', '/TN', TASK])).code === 0;
    } catch {
      return false;
    }
  }
  for (const f of plan.files) {
    try {
      await stat(f.path);
    } catch {
      return false;
    }
  }
  return plan.files.length > 0;
}
