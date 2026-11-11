import { afterEach, describe, expect, it } from 'vitest';
import { createMcpClient, McpError } from '../src/mcpClient.js';
import { sendJson, startServer, type TestServer } from './support/httpServer.js';

const TOKEN = 'turn-token-abc123';
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const start = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};

const rpcId = (body: unknown) => (body as { id: number }).id;

describe('createMcpClient', () => {
  it('sends the headers and _meta envelope, parses a JSON reply', async () => {
    const srv = await start((req, res) => {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId(req.body),
        result: {
          tools: [{ name: 'make_move', description: 'd', inputSchema: { type: 'object' } }],
        },
      });
    });
    const tools = await createMcpClient(`${srv.url}/mcp`, TOKEN).listTools();
    expect(tools).toEqual([
      { name: 'make_move', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const req = srv.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/mcp');
    expect(req.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(req.headers['mcp-name']).toBeUndefined();
    expect(req.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
  });

  it('calls a tool with mcp-name and parses an SSE reply, joining text parts', async () => {
    const srv = await start((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
      res.write(
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId(req.body),
          result: {
            content: [
              { type: 'text', text: 'one' },
              { type: 'image' },
              { type: 'text', text: 'two' },
            ],
            isError: true,
          },
        })}\n\n`,
      );
    });
    const out = await createMcpClient(`${srv.url}/mcp`, TOKEN).callTool('make_move', { san: 'e4' });
    expect(out).toEqual({ text: 'one\ntwo', isError: true });
    const req = srv.requests[0]!;
    expect(req.headers['mcp-method']).toBe('tools/call');
    expect(req.headers['mcp-name']).toBe('make_move');
    expect(req.body).toMatchObject({ params: { name: 'make_move', arguments: { san: 'e4' } } });
  });

  it('rejects an HTTP 401 with McpError and no token in the message', async () => {
    const srv = await start((_req, res) => sendJson(res, 401, { error: TOKEN }));
    const err = await createMcpClient(`${srv.url}/mcp`, TOKEN)
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('rejects a JSON-RPC error with its code only', async () => {
    const srv = await start((req, res) =>
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId(req.body),
        error: { code: -32602, message: `bad ${TOKEN}` },
      }),
    );
    const err = await createMcpClient(`${srv.url}/mcp`, TOKEN)
      .callTool('x', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as Error).message).toContain('-32602');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('never follows a redirect', async () => {
    const target = await start((_req, res) => sendJson(res, 200, {}));
    const srv = await start((_req, res) => {
      res.writeHead(307, { location: `${target.url}/mcp` });
      res.end();
    });
    const err = await createMcpClient(`${srv.url}/mcp`, TOKEN)
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(target.requests).toHaveLength(0);
  });

  it('rejects a body over 1 MB', async () => {
    const srv = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(1024 * 1024 + 10));
    });
    await expect(createMcpClient(`${srv.url}/mcp`, TOKEN).listTools()).rejects.toBeInstanceOf(
      McpError,
    );
  });
});
