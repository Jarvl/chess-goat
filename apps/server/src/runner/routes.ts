import {
  apiErrorBody,
  RunnerClaimRequestSchema,
  RunnerLinkRequestSchema,
  RunnerReleaseRequestSchema,
  type RunnerClaimResponse,
  type RunnerLinkResponse,
  type RunnerTurn,
} from '@chess-goat/shared';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ZodType, z } from 'zod';
import { clientAddress } from '../api/clientAddress';
import type { ApiContext } from '../api/context';
import { RateLimiter } from '../bot/rateLimit';
import type { RunnerRow } from '../db/schema';
import { DomainError, isDomainError } from '../domain/errors';
import { redeemLinkCode, resolveRunner, touchRunner } from '../domain/runners';
import {
  LEASE_DEFAULT_SECONDS,
  claimTurn,
  releaseTurn,
  unclaimTurn,
  type ClaimedTurn,
} from '../domain/turnLeases';
import { loadTurnView, renderTurnPrompt } from '../domain/turnPrompt';
import { issueTurnToken } from '../domain/turnTokens';
import { OwnerGate } from '../mcp/gate';

export const RUNNER_MAX_BODY_BYTES = 16 * 1024;
export const RUNNER_LINKS_PER_MINUTE = 10;
export const RUNNER_LINKS_PER_MINUTE_ALL = 300;
export const RUNNER_AUTH_FAILURES_PER_MINUTE = 60;
export const RUNNER_CALLS_PER_MINUTE = 120;
export const RUNNER_CLAIMS_PER_RUNNER = 4;
export const CLAIM_DEFAULT_WAIT_SECONDS = 50;
/** The runner stops its session this long before the lease ends. */
const EXPIRY_MARGIN_MS = 10_000;
const REREAD_MS = 2_000;

export type RunnerEndpoint = {
  routes: Hono;
  /** Ends open claim polls, so the HTTP server can close. */
  close(): Promise<void>;
};

export type RunnerEndpointOptions = {
  /** Builds the turn a claim returns (a test seam; production uses `renderTurn`). */
  render?: typeof renderTurn;
  /** The time of every database write and token (a test seam; production leaves it unset). */
  now?: () => Date;
};

/** The token of a `Bearer …` header, or null. */
function bearerToken(header: string | undefined): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1] ?? null;
}

/** Resolves after `ms`, or as soon as `signal` fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The JSON body under `schema`; no body at all counts as `{}`. Failures are `validation`. */
async function parseBody<T extends ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  let json: unknown = {};
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      throw new DomainError('validation', 'invalid request');
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DomainError('validation', 'invalid request', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  return parsed.data;
}

/** The turn a claimed lease asks for, or null when it ended between the claim and now. */
export async function renderTurn(
  ctx: ApiContext,
  claimed: ClaimedTurn,
): Promise<RunnerTurn | null> {
  const { lease, bot } = claimed;
  let prompt: string;
  try {
    prompt = renderTurnPrompt(await loadTurnView(ctx.deps.db, lease, bot));
  } catch (error) {
    if (isDomainError(error) && error.details.reason === 'turn_ended') return null;
    throw error;
  }
  const leasedUntil = lease.leasedUntil!;
  return {
    id: lease.id,
    claim_seq: lease.claimSeq,
    kind: lease.kind,
    bot: { id: bot.id, name: bot.firstName },
    persona: bot.persona,
    prompt,
    token: issueTurnToken(ctx.config.SESSION_SECRET, {
      leaseId: lease.id,
      botId: bot.id,
      seq: lease.claimSeq,
      exp: Math.floor(leasedUntil.getTime() / 1000),
    }),
    expires_at: new Date(leasedUntil.getTime() - EXPIRY_MARGIN_MS).toISOString(),
    mcp_url: `${ctx.config.PUBLIC_URL.replace(/\/+$/, '')}/mcp`,
  };
}

/**
 * `/runner`: plain HTTP for the runner on an owner's machine. `link` trades a link code for a
 * credential; `claim` long-polls for the next turn; `release` hands one back. Like `/mcp` it sits
 * beside `/api`, so session auth never sees it. Domain refusals are thrown and shaped by the API's
 * error handler.
 */
export function runnerEndpoint(ctx: ApiContext, opts: RunnerEndpointOptions = {}): RunnerEndpoint {
  const { db, log } = ctx.deps;
  const now = opts.now ?? (() => new Date());
  const linkLimiter = new RateLimiter(RUNNER_LINKS_PER_MINUTE, 60_000);
  const linkAllLimiter = new RateLimiter(RUNNER_LINKS_PER_MINUTE_ALL, 60_000);
  const authFailures = new RateLimiter(RUNNER_AUTH_FAILURES_PER_MINUTE, 60_000);
  const callLimiter = new RateLimiter(RUNNER_CALLS_PER_MINUTE, 60_000);
  const claims = new OwnerGate(RUNNER_CLAIMS_PER_RUNNER);
  const shutdown = new AbortController();
  const render = opts.render ?? renderTurn;
  const serverUrl = ctx.config.PUBLIC_URL.replace(/\/+$/, '');

  const app = new Hono();
  app.use(
    '/runner/*',
    bodyLimit({
      maxSize: RUNNER_MAX_BODY_BYTES,
      onError: (c) => c.json(apiErrorBody('validation', 'request body too large'), 413),
    }),
  );

  /** The runner a `cgrun_…` bearer names, or a 401 response. Counts the call against its budget. */
  const authenticate = async (c: Context): Promise<RunnerRow | Response> => {
    const token = bearerToken(c.req.header('authorization'));
    const found = token ? await resolveRunner(db, token, now()) : null;
    // One answer for every failure, as on /mcp.
    if (!found) {
      // Only failures count, so guessing credentials is throttled and real runners are not.
      if (!authFailures.allow(clientAddress(c, ctx.config.TRUST_PROXY_HOPS))) {
        throw new DomainError('rate_limited', 'too many requests');
      }
      return c.json(apiErrorBody('unauthorized', 'a valid token is required'), 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (!callLimiter.allow(String(found.runner.id))) {
      throw new DomainError('rate_limited', 'too many requests');
    }
    return found.runner;
  };

  app.post('/runner/link', async (c) => {
    if (
      !linkLimiter.allow(clientAddress(c, ctx.config.TRUST_PROXY_HOPS)) ||
      !linkAllLimiter.allow('all')
    ) {
      throw new DomainError('rate_limited', 'too many requests');
    }
    const body = await parseBody(c, RunnerLinkRequestSchema);
    const { runner, credential, preset } = await db.transaction((tx) =>
      redeemLinkCode(tx, body.code, { label: body.label, harness: body.harness }, now()),
    );
    log.info({ runnerId: runner.id }, 'runner linked');
    const response: RunnerLinkResponse = {
      credential,
      runner_id: runner.id,
      preset,
      server: serverUrl,
    };
    return c.json(response);
  });

  /** Returns an undelivered lease without blaming the bot; a failure here must not hide the cause. */
  const giveBack = async (runnerId: number, lease: ClaimedTurn['lease']): Promise<void> => {
    try {
      await unclaimTurn(db, runnerId, lease.id, lease.claimSeq);
    } catch (error) {
      log.warn({ runnerId, leaseId: lease.id, err: error }, 'could not give back a lease');
    }
  };

  app.post('/runner/claim', async (c) => {
    const runner = await authenticate(c);
    if (runner instanceof Response) return runner;
    const body = await parseBody(c, RunnerClaimRequestSchema);
    const releaseSlot = claims.acquire(runner.id);
    if (!releaseSlot) throw new DomainError('rate_limited', 'too many open claims');
    const signal = AbortSignal.any([c.req.raw.signal, shutdown.signal]);
    const waitMs = (body.wait_seconds ?? CLAIM_DEFAULT_WAIT_SECONDS) * 1000;
    // Elapsed time is real time: the injected clock stamps rows, it does not pace the poll.
    const started = Date.now();
    try {
      // Seen as the poll starts and as it ends, so a long wait never looks offline.
      await touchRunner(db, runner.id, now());
      for (;;) {
        const claimed = await claimTurn(ctx.deps, runner, {
          leaseSeconds: body.lease_seconds ?? LEASE_DEFAULT_SECONDS,
          now: now(),
        });
        if (claimed) {
          const { lease } = claimed;
          let turn: RunnerTurn | null;
          try {
            turn = await render(ctx, claimed);
          } catch (error) {
            if (isDomainError(error) && error.details.reason === 'turn_ended') {
              turn = null;
            } else {
              await giveBack(runner.id, lease);
              throw error;
            }
          }
          if (turn && signal.aborted) {
            // The client left while we worked: nobody will play this, and the bot is not to blame.
            await giveBack(runner.id, lease);
            return c.json({ turn: null } satisfies RunnerClaimResponse);
          }
          if (turn) return c.json({ turn } satisfies RunnerClaimResponse);
          // Gone between claim and render: give it back and look for another.
          await releaseTurn(db, runner.id, lease.id, lease.claimSeq, now());
          if (!signal.aborted) continue;
        }
        const left = waitMs - (Date.now() - started);
        if (signal.aborted || left <= 0)
          return c.json({ turn: null } satisfies RunnerClaimResponse);
        await pause(Math.min(REREAD_MS, left), signal);
      }
    } finally {
      releaseSlot();
      try {
        await touchRunner(db, runner.id, now());
      } catch (error) {
        log.warn({ runnerId: runner.id, err: error }, 'runner touch failed');
      }
    }
  });

  app.post('/runner/release', async (c) => {
    const runner = await authenticate(c);
    if (runner instanceof Response) return runner;
    const body = await parseBody(c, RunnerReleaseRequestSchema);
    await releaseTurn(db, runner.id, body.turn_id, body.claim_seq, now());
    // Ids and the reason code only: `detail` is the runner's text and stays out of the logs.
    log.info({ runnerId: runner.id, leaseId: body.turn_id, reason: body.reason }, 'turn released');
    return c.body(null, 204);
  });

  return {
    routes: app,
    close: async () => {
      shutdown.abort();
    },
  };
}

/** The `/runner` routes alone, for callers that never shut down (tests). */
export function runnerRoutes(ctx: ApiContext, opts: RunnerEndpointOptions = {}): Hono {
  return runnerEndpoint(ctx, opts).routes;
}
