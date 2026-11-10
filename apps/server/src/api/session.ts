import { sign, verify } from 'hono/jwt';
import { DomainError } from '../domain/errors';

export const SESSION_TTL_SECONDS = 86_400;
/** A download link is meant to be used at once; five minutes covers a slow tap. */
export const LINK_TTL_SECONDS = 300;

export type VerifiedToken = { userId: number; scope: string | null };

/** HS256 JWT with `sub`, `iat`, `exp`. */
export async function issueSessionToken(
  secret: string,
  userId: number,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return sign({ sub: String(userId), iat, exp: iat + SESSION_TTL_SECONDS }, secret, 'HS256');
}

/**
 * A token that is good for one purpose only (`scope`, e.g. `pgn:<game public id>`) and briefly:
 * what the app hands to the system browser or Telegram's downloader instead of the session.
 */
export async function issueScopedToken(
  secret: string,
  userId: number,
  scope: string,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return sign({ sub: String(userId), iat, exp: iat + LINK_TTL_SECONDS, scope }, secret, 'HS256');
}

export async function verifyToken(secret: string, token: string): Promise<VerifiedToken> {
  try {
    const payload = await verify(token, secret, 'HS256');
    const userId = typeof payload.sub === 'string' ? Number(payload.sub) : Number.NaN;
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('bad subject');
    const scope = typeof payload.scope === 'string' ? payload.scope : null;
    return { userId, scope };
  } catch {
    throw new DomainError('unauthorized', 'invalid session');
  }
}

/** A full session token; a scoped one is refused here. */
export async function verifySessionToken(secret: string, token: string): Promise<number> {
  const verified = await verifyToken(secret, token);
  if (verified.scope !== null) throw new DomainError('unauthorized', 'invalid session');
  return verified.userId;
}
