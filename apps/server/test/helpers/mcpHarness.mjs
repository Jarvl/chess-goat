// A stand-in agent harness for the runner end-to-end tests: plain Node, no dependencies.
// Usage: node mcpHarness.mjs <mcp-config-file> <prompt-file>
// It reads the MCP URL from the config (Claude Code's shape) and the turn token ONLY from
// GOAT_TURN_TOKEN, lists the turn's tools, acts once by what they offer, then exits 0.
import { readFileSync } from 'node:fs';

const VERSION = '2026-07-28';
const [configFile, promptFile] = process.argv.slice(2);
const token = process.env.GOAT_TURN_TOKEN;
if (!token) throw new Error('GOAT_TURN_TOKEN is not set');
const url = Object.values(JSON.parse(readFileSync(configFile, 'utf8')).mcpServers)[0].url;
// Read to prove the file is there; the tools say what the turn is.
if (readFileSync(promptFile, 'utf8').length === 0) throw new Error('empty prompt');

let nextId = 0;
async function rpc(method, params = {}) {
  const id = ++nextId;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    authorization: `Bearer ${token}`,
  };
  if (method === 'tools/call') headers['mcp-name'] = params.name;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const text = await res.text();
  const frames = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split(/\r?\n\r?\n/)
        .map((f) =>
          f
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n'),
        )
        .filter(Boolean)
        .map((d) => JSON.parse(d))
    : [JSON.parse(text)];
  const reply = frames.find((m) => m.id === id);
  if (!reply || reply.error) throw new Error(`${method}: ${JSON.stringify(reply?.error)}`);
  return reply.result;
}

const call = async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
};

const tools = new Set((await rpc('tools/list')).tools.map((t) => t.name));
if (tools.has('hello')) {
  await call('hello');
} else if (tools.has('respond_to_challenge')) {
  await call('respond_to_challenge', { accept: true });
} else if (tools.has('make_move')) {
  const { legalMoves } = await call('get_position');
  if (legalMoves.length === 0) throw new Error('no legal move');
  await call('make_move', { move: legalMoves[0].uci });
}
// Any other kind (game over, draw offer): nothing to do.
