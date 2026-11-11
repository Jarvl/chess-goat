import type { RunnerTurn } from '@chess-goat/shared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RunnerRevokedError, ServerError, type Client } from './client.js';
import type { RunnerConfig } from './config.js';
import { isLoopbackHost } from './http.js';
import { cleanLine, type Logger } from './log.js';
import { botDir } from './paths.js';
import { presetFor } from './presets/index.js';
import { runLeanTurn } from './presets/lean.js';
import { runSession, type SessionResult } from './session.js';

export type { Logger };

export type LoopDeps = {
  client: Client;
  config: RunnerConfig;
  dataDir: string;
  log: Logger;
  now?: () => number;
  /** A steady clock (ms), for the lease budget; performance.now unless a test says otherwise. */
  mono?: () => number;
  /** Where per-turn temporary folders go; the OS temp dir unless a test says otherwise. */
  tmpRoot?: string;
  timing?: { backoffBaseMs?: number; rateLimitWaitMs?: number; minLeftMs?: number };
  hooks?: {
    onTurnStart?(turn: RunnerTurn): void;
    onTurnEnd?(turn: RunnerTurn, result: SessionResult): void;
  };
};

const WAIT_SECONDS = 50;
const BACKOFF_MAX_MS = 60_000;
const MAX_SESSION_MS = 15 * 60_000;
const STOP_RELEASE_MS = 10_000;
const NAME_MAX = 64;
const OUTPUT_MAX = 500;
const ERROR_MAX = 200;
const isPosix = process.platform !== 'win32';

type Outcome = { reason: 'exited' | 'timeout' | 'error'; detail: string };

/** Other people's text on a log line: no control characters, bounded. */
export function safe(text: string, max = NAME_MAX): string {
  let out = cleanLine(text).slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (out.length === max && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why a turn's MCP address is not to be used (the release detail), or null when it is fine. */
export function mcpRefusal(mcpUrl: string, server: string): string | null {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return 'refused: mcp_url origin';
  }
  if (url.origin !== new URL(server).origin) return 'refused: mcp_url origin';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return 'refused: insecure mcp_url';
  return null;
}

export async function runLoop(deps: LoopDeps, signal: AbortSignal): Promise<'stopped' | 'revoked'> {
  const { client, config, dataDir, log } = deps;
  const now = deps.now ?? Date.now;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const backoffBase = deps.timing?.backoffBaseMs ?? 1000;
  const rateLimitWait = deps.timing?.rateLimitWaitMs ?? 5000;
  const minLeft = deps.timing?.minLeftMs ?? 5000;
  const mono = deps.mono ?? (() => performance.now());
  let skewWarned = false;

  // `halt` is aborted on revocation; `stop` means "the loop is ending", for either reason.
  const halt = new AbortController();
  const stop = AbortSignal.any([signal, halt.signal]);
  const releaseCtl = new AbortController(); // gives the shutdown releases 10 s together
  let revoked = false;
  const markRevoked = () => {
    revoked = true;
    halt.abort();
    releaseCtl.abort(); // a stalled release must not hold the shutdown
  };
  let releaseTimer: NodeJS.Timeout | undefined;
  // The 10 s run from the moment of stopping, shared by every release.
  const onStop = () => {
    if (!revoked) releaseTimer = setTimeout(() => releaseCtl.abort(), STOP_RELEASE_MS);
  };
  stop.addEventListener('abort', onStop, { once: true });
  if (stop.aborted) onStop();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stop.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        stop.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stop.addEventListener('abort', done, { once: true });
    });

  async function release(turn: RunnerTurn, name: string, outcome: Outcome): Promise<void> {
    if (revoked) return; // the server would answer 401 again
    try {
      await client.release(
        {
          turn_id: turn.id,
          claim_seq: turn.claim_seq,
          reason: outcome.reason,
          detail: outcome.detail,
        },
        releaseCtl.signal,
      );
    } catch (e) {
      if (e instanceof RunnerRevokedError) return markRevoked();
      log.warn(`${name}: could not report the turn: ${safe(messageOf(e), ERROR_MAX)}`);
    }
  }

  async function runLean(turn: RunnerTurn, timeoutMs: number): Promise<SessionResult> {
    const lean = config.lean!;
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    const timer = setTimeout(abort, timeoutMs);
    stop.addEventListener('abort', abort, { once: true });
    if (stop.aborted) abort();
    try {
      const key = lean.apiKeyEnv ? process.env[lean.apiKeyEnv] : undefined;
      return await runLeanTurn(
        turn,
        { baseUrl: lean.baseUrl, model: lean.model, ...(key ? { apiKey: key } : {}) },
        ctl.signal,
      );
    } finally {
      clearTimeout(timer);
      stop.removeEventListener('abort', abort);
    }
  }

  /** Runs the turn's session and says how it ended. Throws only on an unexpected fault. */
  async function execute(turn: RunnerTurn, name: string, claimedAt: number): Promise<Outcome> {
    const refusal = mcpRefusal(turn.mcp_url, config.server);
    if (refusal) {
      log.warn(
        refusal.endsWith('origin')
          ? `${name}: turn refused, the server gave an MCP address on another origin`
          : `${name}: turn refused, the server gave an insecure MCP address`,
      );
      return { reason: 'error', detail: refusal };
    }

    // The lease length, measured on a steady clock from the moment the claim answer arrived (the server starts the lease when it hands the turn
    // out, after the long poll), is the
    // trusted bound; expires_at on the local wall clock can only shorten it, and only when the
    // two roughly agree (a wrong local clock must neither skip every turn nor overrun the lease).
    const leaseMs = (config.leaseSeconds - 10) * 1000;
    const leaseBudget = leaseMs - (mono() - claimedAt);
    const wall = Date.parse(turn.expires_at) - now();
    let left: number;
    // A little negative is jitter between the clocks, not skew.
    if (wall >= -2000 && wall <= config.leaseSeconds * 1000) {
      left = Math.min(Math.max(wall, 0), leaseBudget);
    } else {
      left = leaseBudget;
      if (!skewWarned) {
        skewWarned = true;
        log.warn(
          Number.isFinite(wall)
            ? `this computer's clock disagrees with the server by about ${Math.round(Math.abs(wall - leaseMs) / 1000)} s; using the lease length instead`
            : 'the server sent a turn with no usable expiry; using the lease length instead',
        );
      }
    }
    if (left < minLeft) {
      log.info(`${name}: ${turn.kind} turn, skipped, too little time left`);
      return { reason: 'timeout', detail: `skipped: ${Math.round(left)} ms left` };
    }
    const timeoutMs = Math.min(left, MAX_SESSION_MS);

    const preset = presetFor(config);
    const presetName = preset === 'lean' ? 'lean' : preset.name;
    const unprepared: Outcome = { reason: 'error', detail: 'could not prepare the session' };
    let tmp: string | undefined;
    let result: SessionResult;
    try {
      let cwd: string;
      try {
        cwd = botDir(dataDir, turn.bot.id);
        fs.mkdirSync(cwd, { recursive: true, ...(isPosix ? { mode: 0o700 } : {}) });
        if (preset !== 'lean') {
          tmp = await fs.promises.mkdtemp(path.join(tmpRoot, 'goat-runner-'));
          if (isPosix) await fs.promises.chmod(tmp, 0o700);
        }
      } catch {
        log.warn(`${name}: could not prepare the session`);
        return unprepared;
      }
      let spec;
      if (preset !== 'lean') {
        try {
          spec = preset.session(turn, await preset.writeFiles(turn, tmp!), cwd);
        } catch {
          log.warn(`${name}: could not prepare the session`);
          return unprepared;
        }
      }
      deps.hooks?.onTurnStart?.(turn);
      result = spec
        ? await runSession(spec, { timeoutMs, signal: stop })
        : await runLean(turn, timeoutMs);
    } finally {
      if (tmp)
        await fs.promises
          .rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          .catch(() => {});
    }
    deps.hooks?.onTurnEnd?.(turn, result);

    const seconds = Math.round(result.ms / 1000);
    const failed = result.reason !== 'exited' || result.exitCode !== 0;
    const exit = result.reason === 'exited' && failed ? `, exit ${result.exitCode ?? 'none'}` : '';
    // A session the stop signal ended is not a timeout of its own.
    const ended =
      stop.aborted && result.reason === 'timeout'
        ? `stopped after ${seconds} s`
        : `${result.reason} in ${seconds} s`;
    log.info(`${name}: ${turn.kind} turn, ${ended}${exit}`);
    if (failed && result.tail !== '') {
      log.warn(`${name}: last output: ${safe(result.tail.slice(-OUTPUT_MAX), OUTPUT_MAX)}`);
    }
    if (stop.aborted && result.reason === 'timeout') {
      return { reason: 'timeout', detail: 'runner stopping' };
    }
    return {
      reason: result.reason,
      detail: `${presetName} ${result.reason}; exit ${result.exitCode ?? 'none'}; ${seconds} s`,
    };
  }

  async function handle(turn: RunnerTurn, claimedAt: number): Promise<void> {
    const name = safe(turn.bot.name);
    let outcome: Outcome;
    try {
      outcome = await execute(turn, name, claimedAt);
    } catch (e) {
      log.warn(`${name}: internal error: ${safe(messageOf(e), ERROR_MAX)}`);
      outcome = { reason: 'error', detail: 'internal error' };
    }
    await release(turn, name, outcome);
  }

  log.info(
    `goat-runner started: server ${new URL(config.server).origin}, preset ${config.preset}, up to ${config.concurrency} sessions`,
  );

  const inflight = new Set<Promise<void>>();
  const active = new Set<number>(); // turn ids in hand
  let failing = false;
  let failures = 0;

  while (!stop.aborted) {
    if (inflight.size >= config.concurrency) {
      await Promise.race(inflight);
      continue;
    }
    try {
      const turn = await client.claim(
        { wait_seconds: WAIT_SECONDS, lease_seconds: config.leaseSeconds },
        stop,
      );
      const claimedAt = mono();
      failures = 0;
      if (failing) {
        failing = false;
        log.info('connected again');
      }
      if (turn && active.has(turn.id)) {
        // Never release it: that would end the session that is really playing it.
        log.warn(`turn ${turn.id} was handed out again while still running; ignoring`);
      } else if (turn) {
        active.add(turn.id);
        const p: Promise<void> = handle(turn, claimedAt).finally(() => {
          inflight.delete(p);
          active.delete(turn.id);
        });
        inflight.add(p);
      }
    } catch (e) {
      if (e instanceof RunnerRevokedError) {
        markRevoked();
      } else if (stop.aborted) {
        // stopping: the loop condition ends it
      } else if (e instanceof ServerError && e.status === 429) {
        await sleep(rateLimitWait);
      } else {
        const wait = Math.min(BACKOFF_MAX_MS, backoffBase * 2 ** failures);
        if (!failing) {
          failing = true;
          log.warn(
            e instanceof ServerError
              ? `server answered ${e.status}; retrying in ${Math.round(wait / 1000)} s`
              : `server unreachable: ${safe(messageOf(e), ERROR_MAX)}; retrying`,
          );
        }
        await sleep(wait);
        failures++;
      }
    }
  }

  await Promise.allSettled([...inflight]);
  clearTimeout(releaseTimer);
  stop.removeEventListener('abort', onStop);
  if (revoked) {
    log.warn('goat-runner stopped: this runner was revoked');
    return 'revoked';
  }
  log.info('goat-runner stopped');
  return 'stopped';
}
