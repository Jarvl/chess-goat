import spawn from 'cross-spawn';
import { win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
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
const DRAIN_WAIT_MS = 1500;
const SECRET_NAME = /(TOKEN|KEY|SECRET)$/i;
const MIN_SECRET_LENGTH = 8;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

// Resolves true when the promise settles within ms; the timer never outlives the call.
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const gone = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return false;
  } catch (e) {
    return codeOf(e) === 'ESRCH';
  }
};

/**
 * Stops a process and everything it started. Never throws.
 *
 * POSIX: SIGTERM, then SIGKILL after 2 s, to the process GROUP (the child leads one because it
 * is spawned detached). A harness that calls setsid or starts detached children escapes the
 * group, and Node has no cheap fix for that. The bare pid is signalled only if the group cannot
 * be (EPERM on the first signal) and the caller says the process has not exited, because a pid
 * that has exited may already belong to someone else.
 *
 * Windows: `taskkill /T /F`. Node exposes no job objects, so descendants that outlive the
 * harness are NOT reaped after a normal exit (`exited: true` skips taskkill: the pid may be
 * recycled and /T would kill an unrelated tree).
 */
export async function killTree(
  pid: number,
  platform: Platform = process.platform as Platform,
  opts: { exited?: boolean } = {},
): Promise<void> {
  try {
    if (platform === 'win32') {
      if (opts.exited) return;
      await new Promise<void>((resolve) => {
        const exe = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        const tk = spawn(exe, ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // A missing process makes taskkill fail; that is the outcome we want.
        tk.on('error', () => resolve());
        tk.on('close', () => resolve());
      });
      return;
    }
    let target = -pid;
    try {
      process.kill(target, 'SIGTERM');
    } catch (e) {
      if (codeOf(e) !== 'EPERM' || opts.exited) return; // ESRCH: the group is gone
      target = pid;
      try {
        process.kill(target, 'SIGTERM');
      } catch {
        return;
      }
    }
    const deadline = Date.now() + TERM_GRACE_MS;
    while (Date.now() < deadline) {
      await sleep(50);
      if (gone(target)) return;
    }
    if (gone(target)) return; // as late as possible before the kill
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // already gone
    }
  } catch {
    // killTree is best effort and must not take the runner down.
  }
}

export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  platform: Platform = process.platform as Platform,
): NodeJS.ProcessEnv {
  const win = platform === 'win32'; // Windows names are case-insensitive
  const norm = (name: string) => (win ? name.toUpperCase() : name);
  const overridden = new Set(Object.keys(extra).map(norm));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (norm(name).startsWith('GOAT_RUNNER_') || overridden.has(norm(name))) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

// Best effort only: it cannot catch a secret the harness transforms (encoded, split across
// writes), one inherited from process.env rather than spec.env, or a name outside the suffix list.
function redact(text: string, env: Record<string, string>): string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length); // longest first, so a substring cannot expose a longer value
  for (const value of secrets) text = text.split(value).join('[redacted]');
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

/**
 * Runs one harness turn. Always resolves; every failure is a result. With detached: true a
 * runner crash does not reach the harness, so the caller must turn its own SIGINT/SIGTERM into
 * the abort signal passed here.
 */
export function runSession(
  spec: SessionSpec,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SessionResult> {
  const started = performance.now();
  const result = (
    reason: SessionResult['reason'],
    exitCode: number | null,
    tail: string,
  ): SessionResult => ({ reason, exitCode, tail, ms: Math.round(performance.now() - started) });
  // Only the command name and the error code: messages can quote arguments or env values.
  const notStarted = (e: unknown) =>
    result('error', null, `${spec.command} could not be started: ${codeOf(e) ?? 'unknown'}`);
  if (opts.signal?.aborted) return Promise.resolve(result('timeout', null, ''));

  return new Promise<SessionResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: childEnv(process.env, spec.env),
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      resolve(notStarted(e));
      return;
    }

    let chunks: Buffer[] = [];
    let size = 0;
    const collect = (data: Buffer) => {
      chunks.push(data);
      size += data.length;
      if (size > BUFFER_BYTES * 2) {
        const kept = Buffer.concat(chunks).subarray(-BUFFER_BYTES);
        chunks = [kept];
        size = kept.length;
      }
    };
    const tailText = () =>
      lastChars(
        redact(Buffer.concat(chunks).subarray(-BUFFER_BYTES).toString('utf8'), spec.env),
        TAIL_CHARS,
      );
    const dropStreams = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;

    let settled = false;
    let busy = false; // an exit or a stop is already being handled
    const finish = (r: SessionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      resolve(r);
    };
    const closed = new Promise<void>((done) => child.on('close', () => done()));

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.stdin?.on('error', () => {}); // the child may exit before reading its input
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);

    child.on('error', (e) => {
      if (child.pid === undefined) return finish(notStarted(e));
      if (hasExited()) return; // the exit path's result stands
      // An error on a running child (a failed kill, say): stop it, then report.
      busy = true;
      void killTree(child.pid).then(() => {
        dropStreams();
        finish(notStarted(e));
      });
    });

    // Resolve on exit, not close: a descendant holding the pipes open must not turn a normal
    // exit into a time-limit timeout.
    child.on('exit', (code) => {
      if (busy) return;
      busy = true;
      void (async () => {
        // Reap first, so a leftover pipe-holder dies and the group id is signalled as soon as the
        // leader is gone (no-op on Windows); then let the remaining output arrive.
        const reaped =
          child.pid === undefined
            ? Promise.resolve()
            : killTree(child.pid, undefined, { exited: true });
        await within(closed, DRAIN_WAIT_MS);
        dropStreams();
        await reaped;
        finish(result('exited', code, tailText()));
      })();
    });

    function stop() {
      if (busy || settled) return;
      busy = true;
      const exited = hasExited();
      void (async () => {
        if (child.pid !== undefined) await killTree(child.pid, undefined, { exited });
        const didClose = await within(closed, exited ? DRAIN_WAIT_MS : CLOSE_WAIT_MS);
        dropStreams();
        const tail = tailText();
        finish(
          result('timeout', null, didClose || exited ? tail : `${tail}\n[session did not exit]`),
        );
      })();
    }

    const timer = setTimeout(stop, opts.timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
  });
}
