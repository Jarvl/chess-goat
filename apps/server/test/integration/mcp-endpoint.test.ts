import { randomBytes } from 'node:crypto';
import { apiErrorBody, HTTP_STATUS_BY_ERROR_CODE, type TurnKind } from '@chess-goat/shared';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runners, turnLeases, users, type UserRow } from '../../src/db/schema';
import { createOwnerToken, revokeOwnerToken } from '../../src/domain/ownerTokens';
import { DomainError } from '../../src/domain/errors';
import { playMove } from '../../src/domain/games';
import { TURN_CALL_BUDGET } from '../../src/domain/turnLeases';
import { issueTurnToken } from '../../src/domain/turnTokens';
import { scopeAuthInfo, type McpCall, type TurnCall } from '../../src/mcp/context';
import { mcpEndpoint } from '../../src/mcp/routes';
import { MCP_INSTRUCTIONS, TURN_INSTRUCTIONS } from '../../src/mcp/server';
import { registerTool, registerTurnTool } from '../../src/mcp/tool';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import {
  callTool,
  claimFor,
  mcpCall,
  openListen,
  resultText,
  startTestMcp,
  type ToolResult,
} from '../helpers/mcp';

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
      "Chess Goat runs correspondence chess in Telegram groups. You set up your owner's bots (🤖); you do not play their games. Manage bots with list_bots, create_bot, update_bot, delete_bot, list_my_groups, add_bot_to_group and remove_bot_from_group. Bots can't challenge people.",
    );
    expect(MCP_INSTRUCTIONS).not.toContain('get_inbox');
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
          authInfo: scopeAuthInfo({
            surface: 'owner',
            deps: api.deps,
            owner,
            publicUrl: 'https://chess.test',
          }),
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
    expect(resultText(result)).toBe('Unknown bot. (code: not_found)');
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

describe('/mcp turn surface', () => {
  /** A bot of `owner` on the move (White) against a person: one claimable move turn. */
  const botOnMove = async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    const game = await insertGame(db, group.id, bot.id, human.id);
    return { bot, game };
  };

  const OWNER_TOOLS = [
    'list_bots',
    'create_bot',
    'update_bot',
    'delete_bot',
    'list_my_groups',
    'add_bot_to_group',
    'remove_bot_from_group',
    'link_runner',
    'list_runners',
    'revoke_runner',
    'get_profile',
    'find_bots',
    'challenge_bot',
  ];

  const toolNames = (reply: Awaited<ReturnType<typeof mcpCall>>) =>
    ((reply.response?.result?.tools ?? []) as { name: string }[]).map((t) => t.name);

  it('lists no owner tools to a turn token', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken } = await claimFor(api, bot);
    const reply = await mcpCall(api.app, turnToken, 'tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).not.toContain('list_bots');
    expect(toolNames(reply)).toEqual(['get_position', 'make_move', 'game_action', 'set_notes']);
  });

  it('still lists the owner tools, unchanged, to an owner token', async () => {
    const reply = await mcpCall(api.app, token, 'tools/list');
    expect(toolNames(reply)).toEqual(OWNER_TOOLS);
  });

  it('gives the turn instructions over a turn token, to initialize and to server/discover', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken } = await claimFor(api, bot);
    // A 2025-06-18 client's initialize, as it sends it: no `_meta` envelope.
    const res = await api.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${turnToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(JSON.stringify(TURN_INSTRUCTIONS));
    const discover = await mcpCall(api.app, turnToken, 'server/discover');
    expect(discover.response?.result?.instructions).toBe(TURN_INSTRUCTIONS);
    expect(TURN_INSTRUCTIONS).toBe(
      'You are playing one turn for a Chess Goat bot. Your instructions are in the message you were given. Use only the tools listed, then stop.',
    );
  });

  it('refuses a runner credential at /mcp with 401', async () => {
    expectBearerChallenge(
      await mcpCall(api.app, `cgrun_${randomBytes(32).toString('base64url')}`, 'tools/list'),
    );
  });

  it('refuses a turn token once its runner is revoked', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken, runner } = await claimFor(api, bot);
    expect((await mcpCall(api.app, turnToken, 'tools/list')).status).toBe(200);
    await db.delete(runners).where(eq(runners.id, runner.id));
    const reply = await mcpCall(api.app, turnToken, 'tools/list');
    expectBearerChallenge(reply);
    expect(reply.body).toEqual(apiErrorBody('unauthorized', 'a valid token is required'));
  });

  it('refuses a turn token for a deleted bot', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken } = await claimFor(api, bot);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bot.id));
    expectBearerChallenge(await mcpCall(api.app, turnToken, 'tools/list'));
  });

  it('refuses a turn token whose lease expired', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken, lease } = await claimFor(api, bot);
    await db
      .update(turnLeases)
      .set({ leasedUntil: new Date(Date.now() - 1000) })
      .where(eq(turnLeases.id, lease.id));
    expectBearerChallenge(await mcpCall(api.app, turnToken, 'tools/list'));
  });

  it('refuses a token from an earlier claim of the same lease', async () => {
    const { bot } = await botOnMove();
    const first = await claimFor(api, bot);
    // Run out two minutes ago, so its 60 s retry delay has passed and the turn is claimable again.
    await db
      .update(turnLeases)
      .set({ leasedUntil: new Date(Date.now() - 120_000) })
      .where(eq(turnLeases.id, first.lease.id));
    const second = await claimFor(api, bot);
    expect(second.lease.id).toBe(first.lease.id);
    expect(second.lease.claimSeq).toBe(first.lease.claimSeq + 1);
    expectBearerChallenge(await mcpCall(api.app, first.token, 'tools/list'));
    expect((await mcpCall(api.app, second.token, 'tools/list')).status).toBe(200);
  });

  it("refuses a turn token whose bot is not the lease's", async () => {
    const { bot } = await botOnMove();
    const other = await insertBot(db, owner);
    const { lease } = await claimFor(api, bot);
    const forged = issueTurnToken(api.config.SESSION_SECRET, {
      leaseId: lease.id,
      botId: other.id,
      seq: lease.claimSeq,
      exp: Math.floor(lease.leasedUntil!.getTime() / 1000),
    });
    expectBearerChallenge(await mcpCall(api.app, forged, 'tools/list'));
  });

  it('refuses a turn token whose lease kind has no surface with 401, not 500', async () => {
    const { bot } = await botOnMove();
    const { token: turnToken, lease } = await claimFor(api, bot);
    await db
      .update(turnLeases)
      .set({ kind: 'unknown_kind' as TurnKind })
      .where(eq(turnLeases.id, lease.id));
    expectBearerChallenge(await mcpCall(api.app, turnToken, 'tools/list'));
  });

  it('refuses a turn token signed with another secret', async () => {
    const { bot } = await botOnMove();
    const { lease } = await claimFor(api, bot);
    const forged = issueTurnToken('x'.repeat(32), {
      leaseId: lease.id,
      botId: bot.id,
      seq: lease.claimSeq,
      exp: Math.floor(lease.leasedUntil!.getTime() / 1000),
    });
    expectBearerChallenge(await mcpCall(api.app, forged, 'tools/list'));
  });
});

describe('registerTurnTool', () => {
  /** `/mcp` with two probe tools on every turn server: one plain, one allowed after the move. */
  const probeEndpoint = () => {
    const runs: TurnCall[] = [];
    const probe = (name: string, allowResolved: boolean) => ({
      name,
      description: name,
      input: z.object({}),
      output: z.object({ leaseId: z.number() }),
      annotations: { readOnlyHint: true },
      allowResolved,
      run: async (call: TurnCall) => {
        runs.push(call);
        return { leaseId: call.lease.id };
      },
      text: (o: { leaseId: number }) => `lease ${o.leaseId}`,
    });
    const endpoint = mcpEndpoint(api.ctx, {
      turnTools: (server) => {
        registerTurnTool(server, probe('probe', false));
        registerTurnTool(server, probe('probe_after', true));
      },
    });
    return { app: endpoint.routes, runs };
  };

  const onMove = async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    const game = await insertGame(db, group.id, bot.id, human.id);
    return { bot, game, ...(await claimFor(api, bot)) };
  };

  it('runs a tool with the bot and lease the token named', async () => {
    const { app, runs } = probeEndpoint();
    const { bot, lease, token: turnToken } = await onMove();
    const result = await callTool(app, turnToken, 'probe');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ leaseId: lease.id });
    expect(runs[0]?.bot.id).toBe(bot.id);
    expect(runs[0]?.lease.claimSeq).toBe(lease.claimSeq);
  });

  it('refuses the 31st call with the budget text', async () => {
    const { app, runs } = probeEndpoint();
    const { token: turnToken, lease } = await onMove();
    for (let i = 0; i < TURN_CALL_BUDGET; i += 1) {
      expect((await callTool(app, turnToken, 'probe')).isError).toBeFalsy();
    }
    const refused = await callTool(app, turnToken, 'probe');
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toBe('This session has used its 30 tool calls; stop.');
    expect(runs).toHaveLength(TURN_CALL_BUDGET);
    const [row] = await db.select().from(turnLeases).where(eq(turnLeases.id, lease.id));
    expect(row?.callsUsed).toBe(TURN_CALL_BUDGET);
  });

  it('refuses a call after the turn resolved as a tool error, unless the tool allows it', async () => {
    const { app, runs } = probeEndpoint();
    const { bot, game, lease, token: turnToken } = await onMove();
    const callsUsed = async () =>
      (await db.select().from(turnLeases).where(eq(turnLeases.id, lease.id)))[0]?.callsUsed;
    await playMove(api.deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0 });
    const reply = await mcpCall(app, turnToken, 'tools/call', { name: 'probe', arguments: {} });
    expect(reply.status).toBe(200);
    const refused = reply.response?.result as ToolResult;
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toBe('This turn has ended; stop.');
    expect(runs).toHaveLength(0);
    // The lease check runs before spendCall: the refused call spent nothing.
    expect(await callsUsed()).toBe(0);
    const allowed = await callTool(app, turnToken, 'probe_after');
    expect(allowed.isError).toBeFalsy();
    expect(runs).toHaveLength(1);
  });

  it('counts a call whose run refuses', async () => {
    const { token: turnToken, lease } = await onMove();
    const endpoint = mcpEndpoint(api.ctx, {
      turnTools: (server) =>
        registerTurnTool(server, {
          name: 'refuse',
          description: 'refuse',
          input: z.object({}),
          output: z.object({}),
          annotations: { readOnlyHint: true },
          run: async () => {
            throw new DomainError('not_found', 'unknown bot');
          },
          text: () => '',
        }),
    });
    const result = await callTool(endpoint.routes, turnToken, 'refuse');
    expect(result.isError).toBe(true);
    const [row] = await db.select().from(turnLeases).where(eq(turnLeases.id, lease.id));
    expect(row?.callsUsed).toBe(1);
  });

  it('does not offer turn tools to an owner token', async () => {
    const { app } = probeEndpoint();
    const reply = await mcpCall(app, token, 'tools/list');
    expect(
      ((reply.response?.result?.tools ?? []) as { name: string }[]).map((t) => t.name),
    ).not.toContain('probe');
  });
});

describe('/mcp turn listen streams', () => {
  type Timer = { ms: number; fire: () => void; cancelled: boolean };

  /** An endpoint whose lease timers fire only when the test says so. */
  const timedEndpoint = () => {
    const timers: Timer[] = [];
    const endpoint = mcpEndpoint(api.ctx, {
      leaseTimer: (ms, fire) => {
        const timer = { ms, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    return { app: endpoint.routes, timers, close: () => endpoint.close() };
  };

  /** Opens a listen stream and reads its acknowledgement. */
  const listen = async (app: Parameters<typeof openListen>[0], who: string) => {
    const res = await openListen(app, who);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('subscriptions/acknowledged');
    return reader;
  };

  const drained = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    for (;;) if ((await reader.read()).done) return true;
  };

  const turnFor = async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    await insertGame(db, group.id, bot.id, human.id);
    return claimFor(api, bot);
  };

  it("ends a turn's listen stream when its lease does, and frees its slot", async () => {
    const { app, timers, close: closeEndpoint } = timedEndpoint();
    const { token: turnToken, lease } = await turnFor();
    const untilEnd = lease.leasedUntil!.getTime() - Date.now();
    const one = await listen(app, turnToken);
    const two = await listen(app, turnToken);
    expect((await openListen(app, turnToken)).status).toBe(HTTP_STATUS_BY_ERROR_CODE.rate_limited);
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(timer.ms).toBeLessThanOrEqual(untilEnd);
      expect(timer.ms).toBeGreaterThan(untilEnd - 10_000);
    }

    timers[0]!.fire();
    expect(await drained(one)).toBe(true);
    // Its slot is free again (the lease in the database is still live).
    const three = await listen(app, turnToken);
    timers[1]!.fire();
    timers[2]!.fire();
    expect(await drained(two)).toBe(true);
    expect(await drained(three)).toBe(true);
    await closeEndpoint();
  });

  it('cancels the lease timer when the client closes the stream', async () => {
    const { app, timers, close: closeEndpoint } = timedEndpoint();
    const { token: turnToken } = await turnFor();
    const reader = await listen(app, turnToken);
    await reader.cancel();
    expect(timers.map((t) => t.cancelled)).toEqual([true]);
    await closeEndpoint();
  });

  it('sets no lease timer on an owner listen stream', async () => {
    const { app, timers, close: closeEndpoint } = timedEndpoint();
    const { token: turnToken } = await turnFor();
    const ownerStream = await listen(app, token);
    expect(timers).toHaveLength(0);
    const turnStream = await listen(app, turnToken);
    timers[0]!.fire();
    expect(await drained(turnStream)).toBe(true);
    // Still open: a frame arrives only when the endpoint closes it.
    let ownerDone = false;
    const reading = drained(ownerStream).then(() => (ownerDone = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ownerDone).toBe(false);
    await closeEndpoint();
    await reading;
  });
});

describe('prompts', () => {
  it('lists none on the owner surface', async () => {
    const list = await mcpCall(api.app, token, 'prompts/list');
    expect(list.response?.error).toBeUndefined();
    expect(list.response?.result?.prompts).toEqual([]);
  });
});
