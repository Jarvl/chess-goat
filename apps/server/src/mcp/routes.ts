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

/** The owner a `Bearer cgbot_…` header names, or null. Session JWTs never resolve here. */
async function bearerOwner(ctx: ApiContext, header: string | undefined): Promise<UserRow | null> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  return resolveOwnerToken(ctx.deps.db, match[1]);
}

/**
 * `/mcp`: owners' agents drive their bots here with an owner token. It sits beside `/api`, not
 * under it, so session auth never sees it and owner tokens open nothing else.
 */
export function mcpRoutes(ctx: ApiContext): Hono {
  const limiter = new RateLimiter(MCP_CALLS_PER_MINUTE, 60_000);
  const handler = createMcpHandler(() => createMcpServer(), {
    // Never 'json': it drops the progress notifications a waiting get_inbox sends.
    responseMode: 'sse',
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
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
    return handler.fetch(c.req.raw, { authInfo: scopeAuthInfo({ deps: ctx.deps, owner }) });
  });
  return app;
}
