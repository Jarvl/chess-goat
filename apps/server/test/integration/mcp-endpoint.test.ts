import { apiErrorBody, HTTP_STATUS_BY_ERROR_CODE } from '@chess-goat/shared';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { UserRow } from '../../src/db/schema';
import { createOwnerToken, revokeOwnerToken } from '../../src/domain/ownerTokens';
import { DomainError } from '../../src/domain/errors';
import { scopeAuthInfo, type McpCall } from '../../src/mcp/context';
import { toolError } from '../../src/mcp/errors';
import { mcpEndpoint } from '../../src/mcp/routes';
import { MCP_INSTRUCTIONS } from '../../src/mcp/server';
import { registerTool } from '../../src/mcp/tool';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';
import { callTool, mcpCall, openListen, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let token: string;

// A fresh app per case: the /mcp rate limiter lives on the route instance.
beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

const expectBearerChallenge = (reply: { status: number; headers: Headers }) => {
  expect(reply.status).toBe(401);
  expect(reply.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
};

describe('/mcp auth', () => {
  it('refuses no token, an unknown token and a session JWT with 401 and WWW-Authenticate: Bearer', async () => {
    expectBearerChallenge(await mcpCall(api.app, null, 'tools/list'));
    expectBearerChallenge(await mcpCall(api.app, `cgbot_${'A'.repeat(43)}`, 'tools/list'));
    expectBearerChallenge(await mcpCall(api.app, 'junk', 'tools/list'));
    expectBearerChallenge(await mcpCall(api.app, await api.sessionFor(owner), 'tools/list'));
    expectBearerChallenge(
      await mcpCall(api.app, null, 'tools/list', {}, { headers: { authorization: token } }),
    );
  });

  it('never echoes the token back', async () => {
    const wrong = `cgbot_${'B'.repeat(43)}`;
    const res = await api.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${wrong}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(wrong);
  });

  it('accepts a token with a trailing newline; list_bots answers', async () => {
    const result = await callTool(api.app, `${token}\n`, 'list_bots');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ bots: [] });
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('accepts the token in the raw header with surrounding whitespace', async () => {
    const result = await callTool(
      api.app,
      '',
      'list_bots',
      {},
      {
        headers: { authorization: `Bearer  ${token}  ` },
      },
    );
    expect(result.structuredContent).toEqual({ bots: [] });
  });

  it('still refuses an owner token on /api/me/groups', async () => {
    const res = await api.request('GET', '/api/me/groups', { token });
    expect(res.status).toBe(401);
  });

  it('stops a revoked token at once', async () => {
    expect((await callTool(api.app, token, 'list_bots')).structuredContent).toEqual({ bots: [] });
    await revokeOwnerToken(db, owner.id);
    expectBearerChallenge(
      await mcpCall(api.app, token, 'tools/call', { name: 'list_bots', arguments: {} }),
    );
  });
});

describe('/mcp limits', () => {
  it('answers a body over 512 KB with 413', async () => {
    const res = await api.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        pad: 'x'.repeat(513 * 1024),
      }),
    });
    expect(res.status).toBe(413);
  });

  it('lets a body just under 512 KB through', async () => {
    const reply = await mcpCall(api.app, token, 'tools/call', {
      name: 'list_bots',
      arguments: {},
      pad: 'x'.repeat(500 * 1024),
    });
    expect(reply.status).toBe(200);
  });

  it('answers the 121st call within a minute like the /api rate limiter', async () => {
    for (let i = 0; i < 120; i += 1) {
      const reply = await mcpCall(api.app, token, 'tools/call', {
        name: 'list_bots',
        arguments: {},
      });
      expect(reply.status).toBe(200);
    }
    const res = await api.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(HTTP_STATUS_BY_ERROR_CODE.rate_limited);
    expect(await res.json()).toEqual(apiErrorBody('rate_limited', 'too many requests'));
  });

  it('counts each owner separately', async () => {
    for (let i = 0; i < 120; i += 1) await mcpCall(api.app, token, 'tools/list');
    const other = await insertUser(db);
    const otherToken = await db.transaction((tx) => createOwnerToken(tx, other.id));
    expect((await mcpCall(api.app, otherToken, 'tools/list')).status).toBe(200);
  });
});

describe('/mcp surface', () => {
  it('lists tools deterministically, each with an outputSchema and annotations', async () => {
    const first = await mcpCall(api.app, token, 'tools/list');
    const second = await mcpCall(api.app, token, 'tools/list');
    expect(first.status).toBe(200);
    const tools = first.response?.result?.tools as {
      name: string;
      outputSchema?: unknown;
      annotations?: unknown;
    }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(second.response?.result?.tools).toEqual(tools);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toBeDefined();
    }
    expect(tools.find((t) => t.name === 'list_bots')?.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it('answers over SSE', async () => {
    const reply = await mcpCall(api.app, token, 'tools/list');
    expect(reply.headers.get('content-type')).toContain('text/event-stream');
  });

  it('sends the instructions in the server identity', async () => {
    const reply = await mcpCall(api.app, token, 'server/discover');
    expect(reply.response?.result?.instructions).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS).toBe(
      "Chess Goat runs correspondence chess in Telegram groups. You act only as your owner's bots (🤖), never as your owner. Manage bots with list_bots, create_bot, update_bot, delete_bot, list_my_groups, add_bot_to_group and remove_bot_from_group. To play, loop: call get_inbox with wait_seconds up to 45, then act on what it returns (respond_to_challenge, get_game, make_move, set_premoves, game_action), and call get_inbox again. Moves need expected_ply, copied from the last get_game or get_inbox result. Human opponents may take hours or days per move; bots can't challenge people.",
    );
  });
});

describe('toolError', () => {
  it('turns a DomainError into a tool error saying what to do next', () => {
    const stale = toolError(
      new DomainError('stale_state', 'the position has changed', { plyCount: 12 }),
    );
    expect(stale.isError).toBe(true);
    expect(stale.content).toEqual([
      {
        type: 'text',
        text: 'The position has changed; it is now ply 12. Call get_game and choose again.',
      },
    ]);
    expect(toolError(new DomainError('not_found', 'unknown bot')).content[0]?.text).toBe(
      'Unknown bot.',
    );
  });

  it('hides an unexpected error behind a generic message', () => {
    const result = toolError(new Error('connection to 10.0.0.1 refused'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('10.0.0.1');
  });
});

describe('registerTool', () => {
  /** A one-tool endpoint, so the helper's error and progress paths can be driven directly. */
  const probeApp = (run: (call: McpCall) => Promise<{ n: number }>) => {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'probe', version: '1' });
        registerTool(server, {
          name: 'probe',
          description: 'probe',
          input: z.object({}),
          output: z.object({ n: z.number() }),
          annotations: { readOnlyHint: true },
          run,
          text: (o) => `n=${o.n}`,
        });
        return server;
      },
      { responseMode: 'sse' },
    );
    return {
      request: (_path: string, init: RequestInit) =>
        handler.fetch(new Request('http://test/mcp', init), {
          authInfo: scopeAuthInfo({ deps: api.deps, owner }),
        }),
    };
  };

  it('returns structuredContent and the text rendering', async () => {
    const result = await callTool(
      probeApp(async () => ({ n: 3 })),
      token,
      'probe',
    );
    expect(result.structuredContent).toEqual({ n: 3 });
    expect(resultText(result)).toBe('n=3');
  });

  it('maps a thrown DomainError to a tool error result', async () => {
    const app = probeApp(async () => {
      throw new DomainError('not_found', 'unknown bot');
    });
    const result = await callTool(app, token, 'probe');
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Unknown bot.');
  });

  it('sends progress only when the request carries a progressToken', async () => {
    const app = probeApp(async (call) => {
      await call.progress('waiting');
      return { n: 1 };
    });
    const withToken = await callTool(app, token, 'probe', {}, { progressToken: 'p1' });
    expect(withToken.notifications).toEqual([
      expect.objectContaining({
        method: 'notifications/progress',
        params: expect.objectContaining({ progressToken: 'p1', progress: 1, message: 'waiting' }),
      }),
    ]);
    expect((await callTool(app, token, 'probe')).notifications).toEqual([]);
  });
});

describe('/mcp listen streams', () => {
  /** Opens a listen stream and waits for its acknowledgement; `close` cancels it. */
  const listen = async (app: Parameters<typeof openListen>[0], who: string) => {
    const res = await openListen(app, who);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('subscriptions/acknowledged');
    return { close: () => reader.cancel() };
  };

  it('holds each owner to two concurrent listen streams', async () => {
    const one = await listen(api.app, token);
    const two = await listen(api.app, token);

    const third = await openListen(api.app, token);
    expect(third.status).toBe(HTTP_STATUS_BY_ERROR_CODE.rate_limited);
    expect(await third.json()).toEqual(
      apiErrorBody('rate_limited', 'too many open listen streams'),
    );

    const other = await insertUser(db);
    const otherToken = await db.transaction((tx) => createOwnerToken(tx, other.id));
    const theirs = await listen(api.app, otherToken);

    await one.close();
    const again = await listen(api.app, token);
    await Promise.all([two, theirs, again].map((stream) => stream.close()));
  });

  it('ends open listen streams on close', async () => {
    const endpoint = mcpEndpoint(api.ctx);
    const res = await openListen(endpoint.routes, token);
    const reader = res.body!.getReader();
    await reader.read(); // the acknowledgement
    await endpoint.close();
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});
