import { apiErrorBody, TurnKindSchema, type TurnKind } from '@chess-goat/shared';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiContext } from '../api/context';
import { RateLimiter } from '../bot/rateLimit';
import { users, type TurnLeaseRow, type UserRow } from '../db/schema';
import { isDomainError } from '../domain/errors';
import { resolveOwnerToken } from '../domain/ownerTokens';
import { isBot } from '../domain/playerKind';
import { requireLiveLease } from '../domain/turnLeases';
import { TURN_TOKEN_PREFIX, verifyTurnToken } from '../domain/turnTokens';
import { scopeAuthInfo, type McpRequestScope } from './context';
import { OwnerGate } from './gate';
import { createOwnerServer, createTurnServer } from './server';

export const MCP_MAX_BODY_BYTES = 512 * 1024;
export const MCP_CALLS_PER_MINUTE = 120;
export const MCP_LISTENS_PER_OWNER = 2;
export const MCP_LISTENS_PER_TURN = 2;
export const MCP_MAX_SUBSCRIPTIONS = 512;

/** The token of a `Bearer …` header, or null. */
function bearerToken(header: string | undefined): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1] ?? null;
}

/**
 * The bot and lease a `cgturn_…` token names, or null: the signature holds and it hasn't expired,
 * the lease is still held under the token's claim and unexpired (its turn may have resolved), and
 * the bot is the token's and the lease's and is not deleted.
 */
async function turnBearer(
  ctx: ApiContext,
  token: string,
): Promise<{ bot: UserRow; lease: TurnLeaseRow } | null> {
  const now = new Date();
  const claim = verifyTurnToken(ctx.config.SESSION_SECRET, token, Math.floor(now.getTime() / 1000));
  if (!claim) return null;
  const { db } = ctx.deps;
  let lease: TurnLeaseRow;
  try {
    lease = await requireLiveLease(db, claim.leaseId, now, {
      allowResolved: true,
      claimSeq: claim.seq,
    });
  } catch (error) {
    if (isDomainError(error)) return null;
    throw error;
  }
  if (lease.botId !== claim.botId) return null;
  const [bot] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, lease.botId), isNull(users.deletedAt)));
  if (!bot || bot.id !== claim.botId || !isBot(bot)) return null;
  return { bot, lease };
}

/**
 * `response` with `release` called once its body ends, errors or is cancelled by the client, and
 * `end` to close it from the server side (which releases too). Each runs at most once.
 */
function releaseWhenDone(
  response: Response,
  release: () => void,
): { response: Response; end(): void } {
  if (!response.body) {
    release();
    return { response, end: () => {} };
  }
  const reader = response.body.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    release();
    return true;
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    async pull() {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (finish()) controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    end: () => {
      if (!finish()) return;
      controller.close();
      void reader.cancel().catch(() => {});
    },
  };
}

export type McpEndpoint = {
  routes: Hono;
  /** Ends open exchanges and listen streams, so the HTTP server can close. */
  close(): Promise<void>;
};

/** Runs `fire` after `ms`; returns a cancel function. */
export type LeaseTimer = (ms: number, fire: () => void) => () => void;

const realTimer: LeaseTimer = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export type McpEndpointOptions = {
  /** Registers extra tools on every turn server (a test seam; the turn tools are in `server.ts`). */
  turnTools?: (server: McpServer, kind: TurnKind) => void;
  /** Ends a turn's listen stream when its lease does (a test seam; real timers by default). */
  leaseTimer?: LeaseTimer;
};

type McpHandler = ReturnType<typeof createMcpHandler>;

/** Where a resolved bearer goes: its scope, its surface's handler, and the key its limits count by. */
type Route = {
  scope: McpRequestScope;
  handler: McpHandler;
  limiter: RateLimiter;
  listens: OwnerGate;
  key: number;
  /** Turn surface only: when the lease ends, and with it any listen stream. */
  endsAt: Date | null;
};

/**
 * `/mcp`: two surfaces, chosen by the bearer token. An owner token (`cgbot_`) sets up the owner's
 * bots; a turn token (`cgturn_`) plays one turn for one bot, with only that turn kind's tools. Any
 * other bearer is refused. It sits beside `/api`, not under it, so session auth never sees it and
 * these tokens open nothing else.
 *
 * Origin and Host (DNS-rebinding) checks are deliberately off: auth is a bearer token, never a
 * cookie, so a rebound page has nothing to ride on.
 */
export function mcpEndpoint(ctx: ApiContext, opts: McpEndpointOptions = {}): McpEndpoint {
  // Keyed by owner id on the owner surface, by lease id on the turn surface.
  const ownerLimiter = new RateLimiter(MCP_CALLS_PER_MINUTE, 60_000);
  const turnLimiter = new RateLimiter(MCP_CALLS_PER_MINUTE, 60_000);
  // Open `subscriptions/listen` streams; Claude Code holds one per connection.
  const ownerListens = new OwnerGate(MCP_LISTENS_PER_OWNER);
  const turnListens = new OwnerGate(MCP_LISTENS_PER_TURN);

  // One handler per surface (and per turn kind), so the SDK's server factory needs no request input.
  const handlerFor = (createServer: () => McpServer): McpHandler =>
    createMcpHandler(createServer, {
      // Never 'json': it drops the progress notifications a waiting tool sends.
      responseMode: 'sse',
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
      // Handler-wide; the per-owner (per-lease) cap above keeps one token from filling it.
      maxSubscriptions: MCP_MAX_SUBSCRIPTIONS,
      onerror: (error) => ctx.deps.log.warn({ reason: error.message }, 'mcp request rejected'),
    });
  const ownerHandler = handlerFor(createOwnerServer);
  const turnHandlers = Object.fromEntries(
    TurnKindSchema.options.map((kind) => [
      kind,
      handlerFor(() => {
        const server = createTurnServer(kind);
        opts.turnTools?.(server, kind);
        return server;
      }),
    ]),
  ) as Partial<Record<TurnKind, McpHandler>>;
  const leaseTimer = opts.leaseTimer ?? realTimer;

  const route = async (token: string): Promise<Route | null> => {
    if (token.startsWith(TURN_TOKEN_PREFIX)) {
      const turn = await turnBearer(ctx, token);
      // A kind with no handler (a row from a newer server, say) is refused like any bad token.
      const handler = turn && turnHandlers[turn.lease.kind];
      if (!turn || !handler) return null;
      return {
        scope: { surface: 'turn', deps: ctx.deps, ...turn },
        handler,
        limiter: turnLimiter,
        listens: turnListens,
        key: turn.lease.id,
        endsAt: turn.lease.leasedUntil,
      };
    }
    // Session JWTs and runner credentials never resolve here.
    const owner = await resolveOwnerToken(ctx.deps.db, token);
    if (!owner) return null;
    return {
      scope: { surface: 'owner', deps: ctx.deps, owner },
      handler: ownerHandler,
      limiter: ownerLimiter,
      listens: ownerListens,
      key: owner.id,
      endsAt: null,
    };
  };

  const app = new Hono();
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: MCP_MAX_BODY_BYTES,
      onError: (c) => c.json(apiErrorBody('validation', 'request body too large'), 413),
    }),
  );
  app.all('/mcp', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const target = token ? await route(token) : null;
    // One answer for every failure: it never says which surface or which check failed.
    if (!target) {
      return c.json(apiErrorBody('unauthorized', 'a valid token is required'), 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    const { handler, listens, key } = target;
    // Every request counts, not only tools/call: listing is rare, and the budget is per token.
    if (!target.limiter.allow(String(key))) {
      return c.json(apiErrorBody('rate_limited', 'too many requests'), 429);
    }
    const authInfo = scopeAuthInfo(target.scope);
    // The only long-lived stream: legacy GET streams are refused (405) by the stateless fallback,
    // and a modern request must carry an Mcp-Method header matching its body, or the SDK rejects it.
    if (c.req.header('mcp-method') !== 'subscriptions/listen') {
      return handler.fetch(c.req.raw, { authInfo });
    }
    const releaseSlot = listens.acquire(key);
    if (!releaseSlot) {
      return c.json(apiErrorBody('rate_limited', 'too many open listen streams'), 429);
    }
    // A turn's stream ends with its lease: the lease was checked only at open. The timer is set
    // first, so every way the stream finishes (including at once) cancels it.
    let leaseEnded = false;
    let end = () => {
      leaseEnded = true;
    };
    const cancelTimer = target.endsAt
      ? leaseTimer(Math.max(target.endsAt.getTime() - Date.now(), 0), () => end())
      : () => {};
    const release = () => {
      cancelTimer();
      releaseSlot();
    };
    try {
      const stream = releaseWhenDone(await handler.fetch(c.req.raw, { authInfo }), release);
      end = stream.end;
      // The lease ran out while the stream was opening.
      if (leaseEnded) stream.end();
      return stream.response;
    } catch (error) {
      release();
      throw error;
    }
  });
  const handlers = [ownerHandler, ...Object.values(turnHandlers)];
  return {
    routes: app,
    close: async () => {
      await Promise.all(handlers.map((handler) => handler.close()));
    },
  };
}

/** The `/mcp` routes alone, for callers that never shut down (tests). */
export function mcpRoutes(ctx: ApiContext): Hono {
  return mcpEndpoint(ctx).routes;
}
