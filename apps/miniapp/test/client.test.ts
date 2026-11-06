import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, createApiClient } from '../src/api/client';
import { fakeFetch } from './support/fakeFetch';

const Hello = z.object({ hello: z.string() });

describe('createApiClient', () => {
  it('sends the bearer token, JSON bodies and parses responses with the schema', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { hello: 'world', extra: 1 } }));
    const client = createApiClient({ fetch });
    client.setToken('tok');
    const out = await client.post('/api/echo', { a: 1 }, Hello);
    expect(out).toEqual({ hello: 'world' }); // the schema strips unknown keys
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/echo', body: { a: 1 } });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('turns an error body into an ApiError with its code and status', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: 'stale_state', message: 'the position has changed' } },
    }));
    const client = createApiClient({ fetch });
    await expect(client.get('/api/games/x', Hello)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'stale_state',
      message: 'the position has changed',
    });
  });

  it('keeps the refusal reason of an error body', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'busy', reason: 'too_many_live_games' } },
    }));
    await expect(createApiClient({ fetch }).get('/api/x', Hello)).rejects.toMatchObject({
      code: 'rate_limited',
      reason: 'too_many_live_games',
    });
  });

  it('treats a non-JSON failure as internal', async () => {
    const { fetch } = fakeFetch(() => ({ status: 502 }));
    await expect(createApiClient({ fetch }).get('/api/x', Hello)).rejects.toMatchObject({
      status: 502,
      code: 'internal',
    });
  });

  it('retries once with a fresh token after a 401', async () => {
    let attempts = 0;
    const { fetch, calls } = fakeFetch(({ headers }) => {
      attempts += 1;
      return headers.get('authorization') === 'Bearer fresh'
        ? { status: 200, body: { hello: 'again' } }
        : { status: 401, body: { error: { code: 'unauthorized', message: 'expired' } } };
    });
    const client = createApiClient({ fetch, onUnauthorized: async () => 'fresh' });
    client.setToken('stale');
    expect(await client.get('/api/me/groups', Hello)).toEqual({ hello: 'again' });
    expect(attempts).toBe(2);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer fresh');
    expect(client.token).toBe('fresh');
  });

  it('gives up when the relaunch yields no token', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'expired' } },
    }));
    const client = createApiClient({ fetch, onUnauthorized: async () => null });
    client.setToken('stale');
    await expect(client.get('/api/me/groups', Hello)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('wraps a dead network as a network ApiError', async () => {
    const client = createApiClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const error = await client.get('/api/x', Hello).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect((error as ApiError).status).toBe(0);
  });

  it('builds urls with a query for EventSource and downloads', () => {
    const client = createApiClient({ baseUrl: 'https://chess.test' });
    expect(client.url('/api/games/abc/events', { token: 'a b' })).toBe(
      'https://chess.test/api/games/abc/events?token=a+b',
    );
    expect(createApiClient({}).url('/api/x')).toBe('/api/x');
  });
});
