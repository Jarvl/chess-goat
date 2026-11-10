import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueSessionToken } from '../../src/api/session';
import { TURN_TOKEN_PREFIX, issueTurnToken, verifyTurnToken } from '../../src/domain/turnTokens';

const SECRET = 'a-test-secret-that-is-long-enough';
const NOW = 1_800_000_000;
const claim = { leaseId: 12, botId: 34, seq: 3, exp: NOW + 300 };
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A token with the given payload, signed by `key`. */
function signed(payload: unknown, key: string | Buffer): string {
  const body = b64(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `${TURN_TOKEN_PREFIX}${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}
const derived = createHmac('sha256', SECRET).update('chess-goat turn token v1').digest();

describe('turn tokens', () => {
  it('round-trips the claim, including seq', () => {
    const token = issueTurnToken(SECRET, claim);
    expect(token.startsWith('cgturn_')).toBe(true);
    expect(verifyTurnToken(SECRET, token, NOW)).toEqual({ leaseId: 12, botId: 34, seq: 3 });
  });

  it('is valid only while now is before exp', () => {
    const token = issueTurnToken(SECRET, claim);
    expect(verifyTurnToken(SECRET, token, claim.exp - 1)).not.toBeNull();
    expect(verifyTurnToken(SECRET, token, claim.exp)).toBeNull();
    expect(verifyTurnToken(SECRET, token, claim.exp + 1)).toBeNull();
  });

  it('refuses a flipped character in the payload or the signature', () => {
    const token = issueTurnToken(SECRET, claim);
    const flip = (at: number) =>
      token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
    const dot = token.indexOf('.');
    expect(verifyTurnToken(SECRET, flip(TURN_TOKEN_PREFIX.length + 2), NOW)).toBeNull();
    expect(verifyTurnToken(SECRET, flip(dot + 2), NOW)).toBeNull();
  });

  it('refuses a token signed with another secret', () => {
    expect(verifyTurnToken(SECRET, issueTurnToken('another-secret', claim), NOW)).toBeNull();
  });

  it('refuses a payload signed with the raw secret instead of the derived key', () => {
    expect(verifyTurnToken(SECRET, signed(claim, SECRET), NOW)).toBeNull();
    expect(verifyTurnToken(SECRET, signed(claim, derived), NOW)).not.toBeNull();
  });

  it('refuses a session JWT, bare or with the turn prefix', async () => {
    const jwt = await issueSessionToken(SECRET, 5, new Date(NOW * 1000));
    expect(verifyTurnToken(SECRET, jwt, NOW)).toBeNull();
    expect(verifyTurnToken(SECRET, `${TURN_TOKEN_PREFIX}${jwt}`, NOW)).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    const token = issueTurnToken(SECRET, claim);
    const bad = [
      '',
      token.replace('cgturn_', 'cgbot_'),
      token.slice('cgturn_'.length),
      token.replace('.', ''),
      `${TURN_TOKEN_PREFIX}!!!.???`,
      `${TURN_TOKEN_PREFIX}${token.split('.')[0]!.slice(7)}.`,
      signed('not json', derived),
      signed('null', derived),
      signed('[1,2,3,4]', derived),
      signed({ leaseId: 1, botId: 2, exp: NOW + 5 }, derived),
      signed({ ...claim, seq: 1.5 }, derived),
      signed({ ...claim, leaseId: '12' }, derived),
      signed({ ...claim, exp: null }, derived),
      `${TURN_TOKEN_PREFIX}${'a'.repeat(600)}.${'b'.repeat(43)}`,
      signed({ ...claim, pad: 'x'.repeat(600) }, derived),
    ];
    for (const value of bad) expect(verifyTurnToken(SECRET, value, NOW)).toBeNull();
  });
});
