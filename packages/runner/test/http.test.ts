import { describe, expect, it } from 'vitest';
import { abortError, cleanText, isAbort, networkDetail, readLimited } from '../src/http.js';

const withCode = (code: string) => Object.assign(new Error('x'), { code });

describe('networkDetail', () => {
  it.each([
    ['ECONNREFUSED', 'connection refused'],
    ['ENOTFOUND', 'host not found'],
    ['EAI_AGAIN', 'host not found'],
    ['ECONNRESET', 'connection reset'],
    ['CERT_HAS_EXPIRED', 'certificate not trusted'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate not trusted'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate not trusted'],
    ['EWHATEVER', 'connection failed'],
  ])('maps %s', (code, text) => {
    expect(networkDetail(withCode(code))).toBe(text);
  });

  it('finds the code in the cause chain, ignores non-string codes, maps timeouts', () => {
    expect(networkDetail(new TypeError('fetch failed', { cause: withCode('ECONNREFUSED') }))).toBe(
      'connection refused',
    );
    expect(networkDetail(Object.assign(new Error('x'), { code: 42 }))).toBe('connection failed');
    const t = new Error('x');
    t.name = 'TimeoutError';
    expect(networkDetail(t)).toBe('timed out');
    expect(networkDetail(undefined)).toBe('connection failed');
  });
});

describe('helpers', () => {
  it('abortError is recognised by isAbort', () => {
    expect(isAbort(abortError())).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
  });

  it('cleanText strips control characters and bounds', () => {
    expect(cleanText('a\n\tb\u007fc  d', 100)).toBe('a b c d');
    expect(cleanText('abcdef', 3)).toBe('abc');
  });

  it('readLimited returns null over the limit', async () => {
    expect(await readLimited(new Response('abc'), 3)).toBe('abc');
    expect(await readLimited(new Response('abcd'), 3)).toBeNull();
  });
});
