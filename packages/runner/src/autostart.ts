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
  /** Files deleted when turning off, after `disable`. */
  remove: string[];
  /** Run after `remove`, failures ignored (systemd must reload once the unit file is gone). */
  afterRemove: string[][];
  /** True when enabling also starts the runner now (launchd with RunAtLoad), so the caller must not. */
  startsNow: boolean;
  /** One sentence saying what is registered and how to remove it by hand. */
  describe: string;
};
export type RunFn = (argv: string[]) => Promise<{ code: number | null; output: string }>;

const LABEL = 'casa.glob.goat-runner';
const UNIT = 'goat-runner.service';
const NAME = 'goat-runner';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_LIMIT = 260;
const COMMAND_TIMEOUT_MS = 15_000;
const RETRY_WAIT_MS = 1000;
const DETAIL_CHARS = 200;

const pathFor = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// systemd expands %specifiers and $VARS in ExecStart; both are escaped by doubling.
const unitArg = (s: string) =>
  `"${s.replace(/[\\"]/g, '\\$&').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
// Environment= expands %specifiers but not $VARS.
const unitEnv = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

export function autostartPlan(
  platform: Platform,
  opts: { nodePath: string; cliPath: string; home: string; uid?: number; env?: NodeJS.ProcessEnv },
): AutostartPlan {
  const { nodePath, cliPath, home } = opts;
  const env = opts.env ?? {};
  const p = pathFor(platform);
  const runHome = env.GOAT_RUNNER_HOME || undefined;
  // Login-started jobs get a minimal PATH on systemd and launchd, so the harness (under
  // ~/.local/bin, nvm, Homebrew) would not be found; register the owner's PATH. Windows Run
  // entries inherit the user's own environment.
  const pathVar = platform === 'win32' ? undefined : env.PATH || undefined;
  // A line break would end the setting early in a unit or plist; no platform wants one here.
  for (const v of [nodePath, cliPath, runHome ?? '', pathVar ?? '']) {
    if (/[\r\n\0]/.test(v)) throw new Error('a path with a line break cannot be registered');
  }
  const vars: [string, string][] = [];
  if (pathVar) vars.push(['PATH', pathVar]);
  if (runHome) vars.push(['GOAT_RUNNER_HOME', runHome]);

  if (platform === 'darwin') {
    if (opts.uid === undefined) throw new Error('uid is required on macOS');
    const plist = p.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const args = [nodePath, cliPath, 'run', '--daemon'];
    const envBlock = vars.length
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${vars.map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>\n`).join('')}  </dict>\n`
      : '';
    const content =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n<dict>\n` +
      `  <key>Label</key>\n  <string>${LABEL}</string>\n` +
      `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>\n` +
      envBlock +
      // RunAtLoad starts the job at once on bootstrap and at every login.
      `  <key>RunAtLoad</key>\n  <true/>\n` +
      // Restart after a crash only, like Restart=on-failure on Linux.
      `  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n` +
      `  <key>ThrottleInterval</key>\n  <integer>30</integer>\n` +
      `  <key>ProcessType</key>\n  <string>Background</string>\n` +
      `</dict>\n</plist>\n`;
    const domain = `gui/${opts.uid}`;
    return {
      platform,
      files: [{ path: plist, content, mode: 0o644 }],
      enable: [['launchctl', 'bootstrap', domain, plist]],
      disable: [['launchctl', 'bootout', `${domain}/${LABEL}`]],
      remove: [plist],
      afterRemove: [],
      startsNow: true,
      describe: `a LaunchAgent at ${plist}; remove it with launchctl bootout ${domain}/${LABEL} and delete that file`,
    };
  }

  if (platform === 'linux') {
    const base =
      env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : p.join(home, '.config');
    const unit = p.join(base, 'systemd', 'user', UNIT);
    // Contract: goat-runner exits 0 when stopped and when another instance is already running,
    // so Restart=on-failure does not restart it. No After=network-online.target: a user manager
    // does not have it; RestartSec=30 is the tolerance for a network that is not up yet.
    const content =
      `[Unit]\nDescription=goat-runner (Chess Goat bot runner)\n\n` +
      `[Service]\nType=simple\n` +
      vars.map(([k, v]) => `Environment=${unitEnv(`${k}=${v}`)}\n`).join('') +
      `ExecStart=${unitArg(nodePath)} ${unitArg(cliPath)} run --daemon\n` +
      `Restart=on-failure\nRestartSec=30\n\n` +
      `[Install]\nWantedBy=default.target\n`;
    return {
      platform,
      files: [{ path: unit, content, mode: 0o644 }],
      // No --now (nor --now on disable): the caller starts and stops the process itself.
      enable: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', UNIT],
      ],
      disable: [['systemctl', '--user', 'disable', UNIT]],
      remove: [unit],
      afterRemove: [['systemctl', '--user', 'daemon-reload']],
      startsNow: false,
      describe: `a systemd user unit at ${unit}; remove it with systemctl --user disable ${UNIT} and delete that file`,
    };
  }

  // Windows: a value under the per-user Run key, not a scheduled task. ONLOGON tasks commonly
  // need elevation, Task Scheduler stops a task after 72 hours and skips it on battery by
  // default, and node.exe in a task opens a console window whose closing kills the bot. The
  // Run key needs no rights; it starts the DETACHING `start` command, which launches the hidden
  // background process and exits at once (a console window may flash briefly at login).
  // Quoting GOAT_RUNNER_HOME through cmd.exe cannot be verified here, so it is refused.
  if (runHome) {
    throw new Error(
      'start at login cannot carry GOAT_RUNNER_HOME on Windows; unset it or start the runner yourself',
    );
  }
  if (nodePath.includes('"') || cliPath.includes('"')) {
    throw new Error('a path containing a double quote cannot be registered');
  }
  const command = `"${nodePath}" "${cliPath}" start`;
  if (command.length > RUN_VALUE_LIMIT) {
    throw new Error(
      `the command line is ${command.length} characters; a Run key value allows at most ${RUN_VALUE_LIMIT}`,
    );
  }
  const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return {
    platform,
    files: [],
    enable: [[exe, 'add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', command, '/f']],
    disable: [[exe, 'delete', RUN_KEY, '/v', NAME, '/f']],
    remove: [],
    afterRemove: [],
    startsNow: false,
    describe: `a Run entry named ${NAME} under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run; remove it with reg delete in that key or in Settings > Apps > Startup`,
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
      else resolve({ code, output });
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
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function setAutostart(
  on: boolean,
  plan: AutostartPlan,
  opts: { run?: RunFn; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; detail: string }> {
  const run = opts.run ?? defaultRun;
  const sleep = opts.sleep ?? wait;
  const quietly = async (cmds: string[][]) => {
    for (const argv of cmds) await run(argv).catch(() => undefined);
  };
  try {
    if (!on) {
      await quietly(plan.disable);
      let failed: string | undefined;
      for (const file of plan.remove) {
        try {
          await rm(file, { force: true });
        } catch (e) {
          failed ??= `could not delete ${file}: ${(e as Error).message}`;
        }
      }
      await quietly(plan.afterRemove);
      return failed ? { ok: false, detail: firstLine(failed) } : { ok: true, detail: 'removed' };
    }

    // launchd refuses to bootstrap a label that is already loaded.
    if (plan.platform === 'darwin') await quietly(plan.disable);
    const written: string[] = [];
    const rollback = () =>
      Promise.all(written.map((f) => rm(f, { force: true }).catch(() => undefined)));
    try {
      for (const f of plan.files) {
        written.push(f.path); // before writing, so a half-written file is rolled back too
        await mkdir(path.dirname(f.path), { recursive: true });
        await writeFile(f.path, f.content, { mode: f.mode ?? 0o644 });
      }
    } catch (e) {
      await rollback();
      return {
        ok: false,
        detail: `could not write the files: ${firstLine((e as Error).message)}`.slice(
          0,
          DETAIL_CHARS,
        ),
      };
    }
    for (const argv of plan.enable) {
      const name = programName(argv);
      let failure: string | undefined;
      // launchd can answer "Bootstrap failed: 5: Input/output error" right after a bootout.
      for (let attempt = 0; attempt < (plan.platform === 'darwin' ? 2 : 1); attempt++) {
        if (attempt > 0) await sleep(RETRY_WAIT_MS);
        try {
          const res = await run(argv);
          failure = res.code === 0 ? undefined : `${name} failed: ${firstLine(res.output)}`;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') failure = `${name} is not available on this machine`;
          else if (code === 'ETIMEDOUT')
            failure = `${name} timed out after ${COMMAND_TIMEOUT_MS / 1000} s`;
          else failure = `${name} failed: ${firstLine((e as Error).message)}`;
          if (code === 'ENOENT') break;
        }
        if (failure === undefined) break;
      }
      if (failure !== undefined) {
        await rollback();
        return { ok: false, detail: failure };
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
      return (await (opts.run ?? defaultRun)([exe, 'query', RUN_KEY, '/v', NAME])).code === 0;
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
