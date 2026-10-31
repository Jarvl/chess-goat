import { PublicIdSchema, UserIdSchema } from '@chess-goat/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { DomainError } from '../domain/errors';
import { getUserById } from '../domain/users';
import type { ApiContext, ApiEnv } from './context';
import { verifyToken } from './session';

/** The one route a scoped token opens, and the scope it must carry. */
function scopeFor(path: string): string | null {
  const match = /^\/api\/games\/([A-Za-z0-9]{10})\/pgn$/.exec(path);
  return match ? `pgn:${match[1]}` : null;
}

/**
 * Bearer session token everywhere (spec §9). Two routes take `?token=` because the client cannot
 * set headers there: the SSE stream takes the session token (it never leaves the web view), and the
 * PGN download takes only a short-lived token scoped to that game (it goes to the system browser or
 * Telegram's downloader).
 */
export function requireSession(ctx: ApiContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const linkScope = scopeFor(c.req.path);
    const tokenInQuery = linkScope !== null || /\/events$/.test(c.req.path);
    const queryToken = tokenInQuery ? (c.req.query('token') ?? null) : null;
    const token = bearer ?? queryToken;
    if (!token) throw new DomainError('unauthorized', 'missing session');
    const { userId, scope } = await verifyToken(ctx.config.SESSION_SECRET, token);
    if (scope !== null && scope !== linkScope)
      throw new DomainError('unauthorized', 'token not valid here');
    if (scope === null && linkScope !== null && bearer === null)
      throw new DomainError('unauthorized', 'a download link needs its own token');
    const user = await getUserById(ctx.deps.db, userId);
    if (!user || user.deletedAt) throw new DomainError('unauthorized', 'unknown session');
    c.set('user', user);
    await next();
  };
}

/** Spec §7.8: 120 API requests per user per minute, counted on the shared limiter. */
export function userRateLimit(ctx: ApiContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!ctx.rateLimiter.allow(String(c.get('user').id)))
      throw new DomainError('rate_limited', 'too many requests');
    await next();
  };
}

/** A user id path parameter; a malformed one is an unknown resource, never a 500. */
export function userIdParam(c: Context, name: string): number {
  const parsed = UserIdSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new DomainError('not_found', `unknown ${name}`);
  return Number(parsed.data);
}

export function publicIdParam(c: Context, name: string): string {
  const value = c.req.param(name);
  const parsed = PublicIdSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('not_found', `unknown ${name}`);
  return parsed.data;
}
