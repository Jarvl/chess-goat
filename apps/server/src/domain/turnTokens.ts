import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const TURN_TOKEN_PREFIX = 'cgturn_';

const MAX_TOKEN_LENGTH = 512;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const id = z.number().int().nonnegative().safe();

const Claim = z.object({
  leaseId: id,
  botId: id,
  seq: id,
  exp: id,
});

/** A key of its own, so a turn token can never verify as a session token (or the reverse). */
function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('chess-goat turn token v1').digest();
}

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', key(secret)).update(body).digest();
}

/** `exp` is epoch seconds; `seq` is the lease's claim sequence, so an earlier claim's token is told apart. */
export function issueTurnToken(
  secret: string,
  claim: { leaseId: number; botId: number; seq: number; exp: number },
): string {
  const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${TURN_TOKEN_PREFIX}${body}.${sign(secret, body).toString('base64url')}`;
}

/** The claim if the signature holds and `exp` (epoch seconds) is in the future; else null, never a throw. */
export function verifyTurnToken(
  secret: string,
  token: string,
  nowSeconds: number,
): { leaseId: number; botId: number; seq: number } | null {
  if (
    typeof token !== 'string' ||
    token.length > MAX_TOKEN_LENGTH ||
    !token.startsWith(TURN_TOKEN_PREFIX)
  )
    return null;
  const parts = token.slice(TURN_TOKEN_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  if (!SIGNATURE.test(signature)) return null;
  const given = Buffer.from(signature, 'base64url');
  if (given.toString('base64url') !== signature) return null;
  const expected = sign(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const claim = Claim.safeParse(payload);
  if (!claim.success || nowSeconds >= claim.data.exp) return null;
  const { leaseId, botId, seq } = claim.data;
  return { leaseId, botId, seq };
}
