import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientAddress } from '../../src/api/clientAddress';

/** The key `clientAddress` gives a request from socket `peer` with the given forwarded header. */
async function keyFor(hops: number, peer: string | null, forwarded?: string): Promise<string> {
  const app = new Hono();
  app.get('/', (c) => c.text(clientAddress(c, hops)));
  const env = peer === null ? undefined : { incoming: { socket: { remoteAddress: peer } } };
  const res = await app.request(
    '/',
    { headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } },
    env,
  );
  return res.text();
}

describe('clientAddress', () => {
  it('is the socket peer with no hops, whatever the header says', async () => {
    expect(await keyFor(0, '203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
  });

  it('takes the Nth entry from the right', async () => {
    expect(await keyFor(1, '10.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(await keyFor(2, '10.0.0.1', '198.51.100.7, 192.0.2.5')).toBe('198.51.100.7');
  });

  it('ignores forged left entries', async () => {
    expect(await keyFor(1, '10.0.0.1', '6.6.6.6, 7.7.7.7, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('falls back to the peer when the header is missing or too short', async () => {
    expect(await keyFor(1, '10.0.0.1')).toBe('10.0.0.1');
    expect(await keyFor(2, '10.0.0.1', '198.51.100.7')).toBe('10.0.0.1');
  });

  it('collapses an IPv6 /64 to one key and separates /64s', async () => {
    const a = await keyFor(0, '2001:db8:1:2:aaaa::1');
    const b = await keyFor(0, '2001:db8:1:2:bbbb:cccc:dddd:eeee');
    const c = await keyFor(0, '2001:db8:1:3::1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await keyFor(1, '10.0.0.1', '2001:db8::5')).toBe(await keyFor(0, '2001:db8:0:0::9'));
  });

  it('treats IPv4-mapped IPv6 as its IPv4 address', async () => {
    expect(await keyFor(0, '::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('is unknown with no socket', async () => {
    expect(await keyFor(0, null)).toBe('unknown');
  });
});
