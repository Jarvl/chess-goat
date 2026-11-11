import spawn from 'cross-spawn';
import type { Platform } from './paths.js';

export type SessionSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin?: string;
};
export type SessionResult = {
  reason: 'exited' | 'timeout' | 'error';
  exitCode: number | null;
  tail: string;
  ms: number;
};

const TAIL_CHARS = 2000;
const BUFFER_BYTES = 64 * 1024;
const TERM_GRACE_MS = 2000;
const CLOSE_WAIT_MS = 5000;
const SECRET_NAME = /(TOKEN|KEY|SECRET)$/i;
const MIN_SECRET_LENGTH = 8;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

// Signals the group (the child leads one because it was spawned detached). Returns false when
// nothing is left to signal.
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    if (codeOf(e) !== 'ESRCH' && codeOf(e) !== 'EPERM') return false;
  }
  // Not a group leader (ESRCH) or not ours to signal as a group (EPERM): try the pid itself.
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Stops a process and everything it started. Never throws. */
export async function killTree(pid: number, platform: Platform = process.platform as Platform) {
  try {
    if (platform === 'win32') {
      await new Promise<void>((resolve) => {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // A missing process makes taskkill fail; that is the outcome we want.
        tk.on('error', () => resolve());
        tk.on('close', () => resolve());
      });
      return;
    }
    if (!signalGroup(pid, 'SIGTERM')) return;
    const deadline = Date.now() + TERM_GRACE_MS;
    while (Date.now() < deadline) {
      await sleep(50);
      if (!signalGroup(pid, 0)) return;
    }
    signalGroup(pid, 'SIGKILL');
  } catch {
    // killTree is best effort and must not take the runner down.
  }
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GOAT_RUNNER_')) delete env[name];
  return { ...env, ...extra };
}

function redact(text: string, env: Record<string, string>): string {
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) {
      text = text.split(value).join('[redacted]');
    }
  }
  return text;
}

function lastChars(text: string, n: number): string {
  if (text.length <= n) return text;
  let out = text.slice(-n);
  // Do not start on the second half of a surrogate pair.
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  return out;
}

/** Runs one harness turn. Always resolves; every failure is a result. */
export function runSession(
  spec: SessionSpec,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SessionResult> {
  const started = Date.now();
  const result = (reason: SessionResult['reason'], exitCode: number | null, tail: string) => ({
    reason,
    exitCode,
    tail,
    ms: Date.now() - started,
  });
  if (opts.signal?.aborted) return Promise.resolve(result('timeout', null, ''));

  return new Promise<SessionResult>((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const collect = (data: Buffer) => {
      chunks.push(data);
      size += data.length;
      if (size > BUFFER_BYTES * 2) {
        const all = Buffer.concat(chunks).subarray(-BUFFER_BYTES);
        chunks = [all];
        size = all.length;
      }
    };
    const tailText = () =>
      lastChars(
        redact(Buffer.concat(chunks).subarray(-BUFFER_BYTES).toString('utf8'), spec.env),
        TAIL_CHARS,
      );

    let settled = false;
    let stopping = false;
    let closeWaiter: (() => void) | undefined;
    const finish = (r: SessionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      resolve(r);
    };

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: childEnv(spec.env),
      stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.stdin?.on('error', () => {}); // the child may exit before reading its input
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);

    child.on('error', (e) => {
      // Only the command name: the arguments can hold the prompt.
      finish(
        result('error', null, `${spec.command} could not be started: ${codeOf(e) ?? 'unknown'}`),
      );
    });
    child.on('close', (code) => {
      closeWaiter?.();
      if (!stopping) finish(result('exited', code, tailText()));
    });

    function stop() {
      if (stopping || settled) return;
      stopping = true;
      const closed = new Promise<boolean>((done) => {
        closeWaiter = () => done(true);
        if (child.exitCode !== null || child.signalCode !== null) done(true);
      });
      const kill = child.pid === undefined ? Promise.resolve() : killTree(child.pid);
      void kill
        .then(() => Promise.race([closed, sleep(CLOSE_WAIT_MS).then(() => false)]))
        .then((didClose) => {
          const tail = tailText();
          finish(result('timeout', null, didClose ? tail : `${tail}\n[session did not exit]`));
        });
    }

    const timer = setTimeout(stop, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
  });
}
