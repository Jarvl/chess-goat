import { apiErrorBody } from '@chess-goat/shared';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiContext } from '../api/context';
import { RateLimiter } from '../bot/rateLimit';
import type { UserRow } from '../db/schema';
import { resolveOwnerToken } from '../domain/ownerTokens';
import { scopeAuthInfo } from './context';
import { createMcpServer } from './server';

export const MCP_MAX_BODY_BYTES = 512 * 1024;
export const MCP_CALLS_PER_MINUTE = 120;
export const MCP_LISTENS_PER_OWNER = 2;
export const MCP_MAX_SUBSCRIPTIONS = 512;

/** The owner a `Bearer cgbot_…` header names, or null. Session JWTs never resolve here. */
async function bearerOwner(ctx: ApiContext, header: string | undefined): Promise<UserRow | null> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  return resolveOwnerToken(ctx.deps.db, match[1]);
}

/** Open `subscriptions/listen` streams per owner id; Claude Code holds one per connection. */
class ListenGate {
  private readonly open = new Map<number, number>();

  constructor(private readonly perOwner: number) {}

  /** A release function, or null when the owner already holds `perOwner` streams. */
  acquire(ownerId: number): (() => void) | null {
    const count = this.open.get(ownerId) ?? 0;
    if (count >= this.perOwner) return null;
    this.open.set(ownerId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(ownerId) ?? 1) - 1;
      if (left > 0) this.open.set(ownerId, left);
      else this.open.delete(ownerId);
    };
  }
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

/**
 * `/mcp`: owners' agents drive their bots here with an owner token. It sits beside `/api`, not
 * under it, so session auth never sees it and owner tokens open nothing else.
 *
 * Origin and Host (DNS-rebinding) checks are deliberately off: auth is a bearer token, never a
 * cookie, so a rebound page has nothing to ride on.
 */
export function mcpEndpoint(ctx: ApiContext): McpEndpoint {
  const limiter = new RateLimiter(MCP_CALLS_PER_MINUTE, 60_000);
  const listens = new ListenGate(MCP_LISTENS_PER_OWNER);
  const handler = createMcpHandler(() => createMcpServer(), {
    // Never 'json': it drops the progress notifications a waiting get_inbox sends.
    responseMode: 'sse',
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    // Handler-wide; the per-owner cap above keeps one token from filling it.
    maxSubscriptions: MCP_MAX_SUBSCRIPTIONS,
    onerror: (error) => ctx.deps.log.warn({ reason: error.message }, 'mcp request rejected'),
  });

  const app = new Hono();
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: MCP_MAX_BODY_BYTES,
      onError: (c) => c.json(apiErrorBody('validation', 'request body too large'), 413),
    }),
  );
  app.all('/mcp', async (c) => {
    const owner = await bearerOwner(ctx, c.req.header('authorization'));
    if (!owner) {
      return c.json(apiErrorBody('unauthorized', 'an owner token is required'), 401, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    // Every request counts, not only tools/call: listing is rare, and the budget is per token.
    if (!limiter.allow(String(owner.id))) {
      return c.json(apiErrorBody('rate_limited', 'too many requests'), 429);
    }
    const authInfo = scopeAuthInfo({ deps: ctx.deps, owner });
    // The only long-lived stream: legacy GET streams are refused (405) by the stateless fallback,
    // and a modern request must carry an Mcp-Method header matching its body, or the SDK rejects it.
    if (c.req.header('mcp-method') !== 'subscriptions/listen') {
      return handler.fetch(c.req.raw, { authInfo });
    }
    const release = listens.acquire(owner.id);
    if (!release) return c.json(apiErrorBody('rate_limited', 'too many open listen streams'), 429);
    try {
      return releaseWhenDone(await handler.fetch(c.req.raw, { authInfo }), release);
    } catch (error) {
      release();
      throw error;
    }
  });
  return { routes: app, close: () => handler.close() };
}

/** The `/mcp` routes alone, for callers that never shut down (tests). */
export function mcpRoutes(ctx: ApiContext): Hono {
  return mcpEndpoint(ctx).routes;
}
