import type http from 'node:http';
import type { RunnerTurn } from '@chess-goat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERSONA } from '../src/presets/common.js';
import { runLeanTurn } from '../src/presets/lean.js';
import { sendJson, startServer, type Recorded, type TestServer } from './support/httpServer.js';

const TOKEN = 'turn-token-Zq81xKfT';
const API_KEY = 'sk-model-key-Pw93mLrB';
const ARG_SECRET = 'argument-value-Hn47';
const RESULT_SECRET = 'result-text-Vb52';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const start = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};

type Msg = Record<string, unknown>;
const call = (name: string, args: unknown = {}, id = `c-${name}`) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const withCalls = (...calls: unknown[]): Msg => ({
  role: 'assistant',
  content: null,
  tool_calls: calls,
});
const text = (content: string): Msg => ({ role: 'assistant', content });

type Mcp = {
  server: TestServer;
  /** tools/call requests that reached the server */
  calls: Recorded[];
};
async function fakeMcp(
  answer: (name: string, args: unknown) => { text: string; isError?: boolean } = () => ({
    text: 'ok',
  }),
  opts: { sse?: boolean; hang?: boolean } = {},
): Promise<Mcp> {
  const server = await start((req, res) => {
    const body = req.body as { id: number; method: string; params: Record<string, unknown> };
    const reply = (result: unknown) => {
      const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (opts.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${msg}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(msg);
      }
    };
    if (body.method === 'tools/list') {
      return reply({
        tools: ['make_move', 'set_notes'].map((name) => ({
          name,
          description: `the ${name} tool`,
          inputSchema: {
            type: 'object',
            properties: {},
            $schema: 'http://json-schema.org/draft-07/schema#',
          },
        })),
      });
    }
    if (opts.hang) return;
    const r = answer(body.params.name as string, body.params.arguments);
    reply({ content: [{ type: 'text', text: r.text }], isError: r.isError ?? false });
  });
  return {
    server,
    get calls() {
      return server.requests.filter((r) => (r.body as { method?: string }).method === 'tools/call');
    },
  };
}

async function fakeModel(
  queue: Msg[],
  handler?: (req: Recorded, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return start((req, res) => {
    if (handler) return handler(req, res);
    const message = queue.shift();
    if (!message) return sendJson(res, 200, { choices: [] });
    sendJson(res, 200, { choices: [{ message }] });
  });
}

const turnFor = (mcp: TestServer, over: Partial<RunnerTurn> = {}): RunnerTurn => ({
  id: 1,
  claim_seq: 1,
  kind: 'move',
  bot: { id: 7, name: 'Botty' },
  persona: 'You are Botty.',
  prompt: 'Your move.',
  token: TOKEN,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  mcp_url: `${mcp.url}/mcp`,
  ...over,
});
const run = (
  turn: RunnerTurn,
  model: TestServer,
  extra: { maxSteps?: number; apiKey?: string } = {},
  signal: AbortSignal = new AbortController().signal,
) => runLeanTurn(turn, { baseUrl: `${model.url}/v1`, model: 'tiny', ...extra }, signal);

const toolMessages = (model: TestServer, n: number) =>
  (model.requests[n]!.body as { messages: Msg[] }).messages.filter((m) => m.role === 'tool');

describe('runLeanTurn', () => {
  it('one tool call then stop: exits 0, sends the documented request', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([
      withCalls(call('make_move', { san: 'e4' })),
      text('Played e4.'),
    ]);
    const r = await run(turnFor(mcp.server), model);
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.tail).toBe('steps: 2; tool calls: make_move ok\nstopped: no tool call');
    const first = model.requests[0]!;
    expect(first.path).toBe('/v1/chat/completions');
    const body = first.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'tiny',
      tool_choice: 'auto',
      stream: false,
      messages: [
        { role: 'system', content: 'You are Botty.' },
        { role: 'user', content: 'Your move.' },
      ],
    });
    expect((body.tools as Msg[])[0]).toEqual({
      type: 'function',
      function: {
        name: 'make_move',
        description: 'the make_move tool',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]!.body).toMatchObject({
      params: { name: 'make_move', arguments: { san: 'e4' } },
    });
    // the second request carries the assistant message and the tool result
    expect(toolMessages(model, 1)).toEqual([
      { role: 'tool', tool_call_id: 'c-make_move', content: 'ok' },
    ]);
  });

  it('works over SSE and with a trailing slash on baseUrl', async () => {
    const mcp = await fakeMcp(undefined, { sse: true });
    const model = await fakeModel([withCalls(call('set_notes', { notes: 'n' })), text('done')]);
    const r = await runLeanTurn(
      turnFor(mcp.server),
      { baseUrl: `${model.url}/v1/`, model: 'tiny' },
      new AbortController().signal,
    );
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(model.requests[0]!.path).toBe('/v1/chat/completions');
  });

  it('a text-only answer exits 1', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([text('I think e4.')]);
    const r = await run(turnFor(mcp.server), model);
    expect(r).toMatchObject({ reason: 'exited', exitCode: 1 });
    expect(r.tail).toBe('steps: 1; tool calls: none\nstopped: no tool call');
    expect(mcp.calls).toHaveLength(0);
  });

  it('uses DEFAULT_PERSONA when the persona is null', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([text('hi')]);
    await run(turnFor(mcp.server, { persona: null }), model);
    const messages = (model.requests[0]!.body as { messages: Msg[] }).messages;
    expect(messages[0]).toEqual({ role: 'system', content: DEFAULT_PERSONA });
  });

  it('stops at maxSteps (default 12, and a given value)', async () => {
    const mcp = await fakeMcp();
    const loop = () => Array.from({ length: 30 }, () => withCalls(call('set_notes', {})));
    const model = await fakeModel(loop());
    const r = await run(turnFor(mcp.server), model, { maxSteps: 3 });
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.tail).toContain('stopped: step limit');
    expect(model.requests).toHaveLength(3);
    const model2 = await fakeModel(loop());
    await run(turnFor(mcp.server), model2);
    expect(model2.requests).toHaveLength(12);
  });

  it.each(['This turn has ended; stop.', 'This session has used its 30 tool calls; stop.'])(
    'stops at once when a tool says %s',
    async (phrase) => {
      const mcp = await fakeMcp(() => ({ text: `${phrase} bye`, isError: true }));
      const model = await fakeModel([
        withCalls(call('make_move', {}), call('set_notes', {})),
        text('never asked'),
      ]);
      const r = await run(turnFor(mcp.server), model);
      expect(r).toMatchObject({ reason: 'exited', exitCode: 1 });
      expect(r.tail).toContain(
        phrase.startsWith('This turn') ? 'stopped: turn ended' : 'stopped: call limit',
      );
      expect(model.requests).toHaveLength(1);
      expect(mcp.calls).toHaveLength(1);
    },
  );

  it('passes a tool error back to the model and counts it failed', async () => {
    const mcp = await fakeMcp(() => ({ text: 'Illegal move.', isError: true }));
    const model = await fakeModel([withCalls(call('make_move', { san: 'zz' })), text('oops')]);
    const r = await run(turnFor(mcp.server), model);
    expect(toolMessages(model, 1)[0]!.content).toBe('Illegal move.');
    expect(r).toMatchObject({ reason: 'exited', exitCode: 1 });
    expect(r.tail).toContain('make_move failed');
  });

  it('does not send an invented tool to the server', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([withCalls(call('drop_table', {})), text('ok')]);
    const r = await run(turnFor(mcp.server), model);
    expect(mcp.calls).toHaveLength(0);
    expect(toolMessages(model, 1)[0]!.content).toBe(
      'No such tool. Use one of: make_move, set_notes.',
    );
    expect(r).toMatchObject({ reason: 'exited', exitCode: 1 });
    expect(r.tail).toContain('(unknown tool) failed');
  });

  it('reports non-JSON arguments to the model and carries on', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([
      withCalls(call('make_move', '{not json')),
      withCalls(call('make_move', { san: 'e4' })),
      text('done'),
    ]);
    const r = await run(turnFor(mcp.server), model);
    expect(toolMessages(model, 1)[0]!.content).toBe('Your arguments were not valid JSON.');
    expect(mcp.calls).toHaveLength(1);
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
    expect(r.tail).toContain('tool calls: make_move failed, make_move ok');
  });

  it('accepts arguments given as an object', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'x', function: { name: 'make_move', arguments: { san: 'd4' } } }],
      },
      text('done'),
    ]);
    const r = await run(turnFor(mcp.server), model);
    expect(r.exitCode).toBe(0);
    expect(mcp.calls[0]!.body).toMatchObject({ params: { arguments: { san: 'd4' } } });
  });

  it('handles a non-array tool_calls as no tool call', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([{ role: 'assistant', content: 'hm', tool_calls: 'nope' }]);
    expect(await run(turnFor(mcp.server), model)).toMatchObject({ reason: 'exited', exitCode: 1 });
  });

  it('sends the API key to the model only and the token to the MCP server only', async () => {
    const mcp = await fakeMcp(() => ({ text: RESULT_SECRET }));
    const model = await fakeModel([
      withCalls(call('make_move', { san: ARG_SECRET })),
      text('done'),
    ]);
    await run(turnFor(mcp.server), model, { apiKey: API_KEY });
    const dump = (s: TestServer) =>
      JSON.stringify(s.requests.map((r) => [r.path, r.headers, r.body]));
    expect(model.requests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(dump(model)).not.toContain(TOKEN);
    expect(dump(mcp.server)).not.toContain(API_KEY);
    expect(mcp.server.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
  });

  it('sends no authorization header to the model without an apiKey', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([text('x')]);
    await run(turnFor(mcp.server), model);
    expect(model.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('puts no model text, argument, result, persona, prompt, token or key in the tail', async () => {
    const PERSONA = 'persona-Kd39-secret-style';
    const PROMPT = 'prompt-Lw71-opponent-name';
    const mcp = await fakeMcp(() => ({ text: RESULT_SECRET }));
    const INVENTED = `invented-${ARG_SECRET}`;
    const model = await fakeModel([
      withCalls(call('make_move', { san: ARG_SECRET }), call(INVENTED, {})),
      text(`${PERSONA} ${PROMPT} ${RESULT_SECRET} ${TOKEN} ${API_KEY}`),
    ]);
    const r = await run(turnFor(mcp.server, { persona: PERSONA, prompt: PROMPT }), model, {
      apiKey: API_KEY,
    });
    expect(r.tail).toBe(
      'steps: 2; tool calls: make_move ok, (unknown tool) failed\nstopped: no tool call',
    );
    for (const secret of [ARG_SECRET, RESULT_SECRET, TOKEN, API_KEY, PERSONA, PROMPT, INVENTED]) {
      expect(r.tail).not.toContain(secret);
    }
  });

  it('errors with the status when the model endpoint answers 404', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([], (_req, res) => sendJson(res, 404, { error: API_KEY }));
    const r = await run(turnFor(mcp.server), model, { apiKey: API_KEY });
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(r.tail).toBe('the model endpoint answered HTTP 404; check baseUrl and model');
    expect(r.tail).not.toContain(API_KEY);
  });

  it('errors on an MCP 401', async () => {
    const mcp = await start((_req, res) => sendJson(res, 401, {}));
    const model = await fakeModel([text('x')]);
    const r = await run(turnFor(mcp), model);
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(r.tail).toContain('401');
    expect(r.tail).not.toContain(TOKEN);
    expect(model.requests).toHaveLength(0);
  });

  it('treats a redirect from the model endpoint as an error and does not follow it', async () => {
    const mcp = await fakeMcp();
    const target = await start((_req, res) => sendJson(res, 200, {}));
    const model = await fakeModel([], (_req, res) => {
      res.writeHead(307, { location: `${target.url}/x` });
      res.end();
    });
    const r = await run(turnFor(mcp.server), model, { apiKey: API_KEY });
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(target.requests).toHaveLength(0);
  });

  it('treats a redirect from the MCP server as an error and does not follow it', async () => {
    const target = await start((_req, res) => sendJson(res, 200, {}));
    const mcp = await start((_req, res) => {
      res.writeHead(302, { location: `${target.url}/mcp` });
      res.end();
    });
    const model = await fakeModel([text('x')]);
    const r = await run(turnFor(mcp), model);
    expect(r).toMatchObject({ reason: 'error', exitCode: null });
    expect(target.requests).toHaveLength(0);
  });

  it('ends in error on an unusable model body and on an oversized one', async () => {
    const mcp = await fakeMcp();
    const junk = await fakeModel([], (_req, res) => sendJson(res, 200, { nothing: true }));
    expect(await run(turnFor(mcp.server), junk)).toMatchObject({
      reason: 'error',
      exitCode: null,
      tail: 'the model endpoint sent a response with no message',
    });
    const big = await fakeModel([], (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(2 * 1024 * 1024 + 10));
    });
    expect(await run(turnFor(mcp.server), big)).toMatchObject({
      reason: 'error',
      exitCode: null,
      tail: 'the model endpoint sent too large a response',
    });
  });

  it('resolves timeout promptly on abort during a slow model response, closing the socket', async () => {
    const mcp = await fakeMcp();
    const ac = new AbortController();
    const model = await fakeModel([], () => {
      setTimeout(() => ac.abort(), 20);
    });
    const started = Date.now();
    const r = await run(turnFor(mcp.server), model, {}, ac.signal);
    expect(r.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    await expect.poll(() => model.closedSockets()).toBeGreaterThan(0);
  });

  it('resolves timeout on abort during a slow MCP call, closing the socket', async () => {
    const mcp = await fakeMcp(undefined, { hang: true });
    const ac = new AbortController();
    const model = await fakeModel([withCalls(call('make_move', {}))]);
    const started = Date.now();
    const running = run(turnFor(mcp.server), model, {}, ac.signal);
    await expect.poll(() => mcp.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    ac.abort();
    const r = await running;
    expect(r.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    await expect.poll(() => mcp.server.closedSockets()).toBeGreaterThan(0);
  });

  it('never rejects when a server destroys the socket mid-response', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([], (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
      res.destroy();
    });
    expect(await run(turnFor(mcp.server), model)).toMatchObject({
      reason: 'error',
      exitCode: null,
    });
    const deadMcp = await start((_req, res) => {
      res.destroy();
    });
    const model2 = await fakeModel([text('x')]);
    expect(await run(turnFor(deadMcp), model2)).toMatchObject({ reason: 'error', exitCode: null });
  });
  it('sends a normalised assistant message: string arguments, one synthesised id', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([
      {
        role: 'assistant',
        content: 'thinking',
        reasoning: 'extra field',
        tool_calls: [{ function: { name: 'make_move', arguments: { san: 'd4' } }, extra: 1 }],
      },
      text('done'),
    ]);
    await run(turnFor(mcp.server), model);
    const messages = (model.requests[1]!.body as { messages: Msg[] }).messages;
    const assistant = messages[2] as {
      role: string;
      content: string;
      reasoning?: unknown;
      tool_calls: { id: string; type: string; function: { name: string; arguments: unknown } }[];
    };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('thinking');
    expect(assistant.reasoning).toBeUndefined();
    const tc = assistant.tool_calls[0]!;
    expect(tc).toEqual({
      id: tc.id,
      type: 'function',
      function: { name: 'make_move', arguments: '{"san":"d4"}' },
    });
    expect(tc.id).not.toBe('');
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: tc.id });
  });

  it('flattens array content and omits tool_calls when there are none', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
    const r = await run(turnFor(mcp.server), model);
    expect(r.reason).toBe('exited');
    const again = await fakeModel([
      withCalls(call('set_notes', {})),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
    await run(turnFor(mcp.server), again);
    const assistant = (again.requests[1]!.body as { messages: Msg[] }).messages[2]!;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('stops after 30 tool calls without asking the model again', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel(
      Array.from({ length: 60 }, () => withCalls(call('set_notes', {}))),
    );
    const r = await run(turnFor(mcp.server), model, { maxSteps: 100 });
    expect(mcp.calls).toHaveLength(30);
    expect(model.requests).toHaveLength(30);
    expect(r.tail).toContain('stopped: call limit');
    expect(r).toMatchObject({ reason: 'exited', exitCode: 0 });
  });

  it('cuts long tool results to 16,000 characters and names an empty one', async () => {
    const mcp = await fakeMcp((name) => ({ text: name === 'make_move' ? 'z'.repeat(20000) : '' }));
    const model = await fakeModel([
      withCalls(call('make_move', {}), call('set_notes', {})),
      text('done'),
    ]);
    await run(turnFor(mcp.server), model);
    const [long, empty] = toolMessages(model, 1);
    expect(long!.content).toBe(`${'z'.repeat(16000)}… (cut)`);
    expect(empty!.content).toBe('(no text)');
  });

  it('strips a top-level $schema from tool parameters', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([text('x')]);
    await run(turnFor(mcp.server), model);
    const tools = (model.requests[0]!.body as { tools: { function: { parameters: object } }[] })
      .tools;
    for (const t of tools) expect(t.function.parameters).not.toHaveProperty('$schema');
    expect(tools[0]!.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('rejects array arguments with their own message and counts them failed', async () => {
    const mcp = await fakeMcp();
    const model = await fakeModel([withCalls(call('make_move', '["e4"]')), text('x')]);
    const r = await run(turnFor(mcp.server), model);
    expect(toolMessages(model, 1)[0]!.content).toBe('Your arguments must be a JSON object.');
    expect(mcp.calls).toHaveLength(0);
    expect(r).toMatchObject({ exitCode: 1 });
    expect(r.tail).toContain('make_move failed');
  });
});
