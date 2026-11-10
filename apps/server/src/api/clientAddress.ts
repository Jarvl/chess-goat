import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { isIPv6 } from 'node:net';

/** The 8 hextets of an IPv6 address (`::` expanded), or null. A trailing dotted IPv4 is returned as is. */
function hextets(address: string): string[] | null {
  const [head = '', tail, ...extra] = address.split('::');
  if (extra.length > 0) return null;
  const parts = (text: string) => (text === '' ? [] : text.split(':'));
  const left = parts(head);
  if (tail === undefined) return left.length === 8 ? left : null;
  const right = parts(tail);
  const fill = 8 - left.length - right.length;
  return fill < 1 ? null : [...left, ...Array<string>(fill).fill('0'), ...right];
}

/** A rate-limit key for `address`: IPv6 reduced to its /64, IPv4-mapped IPv6 as its IPv4. */
export function addressKey(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  if (!isIPv6(bare)) return bare;
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return mapped[1]!;
  const groups = hextets(bare);
  if (!groups || groups.some((g) => g.includes('.'))) return bare;
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

/**
 * The client's address as a rate-limit key. With `hops` 0 it is the socket peer; with N > 0 it is
 * the Nth entry from the right of `X-Forwarded-For` (the left ones are the client's to forge),
 * falling back to the peer when the header is missing or shorter.
 */
export function clientAddress(c: Context, hops: number): string {
  let peer = 'unknown';
  try {
    peer = getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // No socket (an in-process request).
  }
  if (hops > 0) {
    const entries = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const entry = entries.length >= hops ? entries[entries.length - hops] : undefined;
    if (entry) return addressKey(entry);
  }
  return addressKey(peer);
}
