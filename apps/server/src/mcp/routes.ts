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

/** `response` with `release` called once its body ends, errors or is cancelled by the client. */
function releaseWhenDone(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export type McpEndpoint = {
  routes: Hono;
  /** Ends open exchanges and listen streams, so the HTTP server can close. */
  close(): Promise<void>;
};

export type McpEndpointOptions = {
  /** Registers extra tools on every turn server (a test seam; the turn tools are in `server.ts`). */
  turnTools?: (server: McpServer, kind: TurnKind) => void;
};

type McpHandler = ReturnType<typeof createMcpHandler>;

/** Where a resolved bearer goes: its scope, its surface's handler, and the key its limits count by. */
type Route = {
  scope: McpRequestScope;
  handler: McpHandler;
  limiter: RateLimiter;
  listens: OwnerGate;
  key: number;
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
  ) as Record<TurnKind, McpHandler>;

  const route = async (token: string): Promise<Route | null> => {
    if (token.startsWith(TURN_TOKEN_PREFIX)) {
      const turn = await turnBearer(ctx, token);
      if (!turn) return null;
      return {
        scope: { surface: 'turn', deps: ctx.deps, ...turn },
        handler: turnHandlers[turn.lease.kind],
        limiter: turnLimiter,
        listens: turnListens,
        key: turn.lease.id,
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
    // One answer for every failure: it never says which check a turn token failed.
    if (!target) {
      return c.json(apiErrorBody('unauthorized', 'an owner token is required'), 401, {
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
    const release = listens.acquire(key);
    if (!release) return c.json(apiErrorBody('rate_limited', 'too many open listen streams'), 429);
    try {
      return releaseWhenDone(await handler.fetch(c.req.raw, { authInfo }), release);
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
