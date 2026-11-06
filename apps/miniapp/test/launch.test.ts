import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { launch } from '../src/api/launch';
import { applyLaunch, prefs, serverNow, session } from '../src/state/session';
import { fakeFetch } from './support/fakeFetch';

const response = {
  token: 'jwt',
  user: { id: '7', name: 'Alice', username: 'alice' },
  prefs: {
    notifications: false,
    moveConfirmations: 'people',
    boardTheme: null,
    pieceSet: null,
  },
  askWriteAccess: true,
  yourMove: 3,
  route: { kind: 'home', games: { items: [] } },
  serverTime: new Date(Date.now() + 5_000).toISOString(),
  bot: {
    username: 'TestChessBot',
    miniAppShortName: 'chess',
    mcpUrl: 'https://chess.test/mcp',
  },
};

describe('launch', () => {
  it('posts the init data, stores the token and applies the session', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: response }));
    const client = createApiClient({ fetch });
    const outcome = await launch(client, 'user=x&hash=y');
    expect(outcome.kind).toBe('ok');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/launch',
      body: { initData: 'user=x&hash=y' },
    });
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(client.token).toBe('jwt');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    applyLaunch(outcome.response, 'g_AbCdEfGhIj');
    expect(session.value).toMatchObject({
      user: { id: '7', name: 'Alice' },
      launchedFrom: { kind: 'game', gameId: 'AbCdEfGhIj' },
    });
    expect(prefs.value.notifications).toBe(false);
    expect(Math.abs(serverNow().getTime() - Date.now() - 5_000)).toBeLessThan(1_000);
  });

  it('reports an expired launch on 401 and a failure otherwise', async () => {
    const unauthorized = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'stale' } },
    }));
    expect((await launch(createApiClient({ fetch: unauthorized.fetch }), 'x')).kind).toBe(
      'expired',
    );
    const broken = fakeFetch(() => ({
      status: 500,
      body: { error: { code: 'internal', message: 'x' } },
    }));
    const outcome = await launch(createApiClient({ fetch: broken.fetch }), 'x');
    expect(outcome.kind).toBe('failed');
  });
});
