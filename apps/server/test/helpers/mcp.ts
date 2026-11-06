import { mcpRoutes } from '../../src/mcp/routes';
import type { Db } from '../../src/db/client';
import type { Config } from '../../src/config';
import { startTestApi, type TestApi } from './api';

/** The protocol revision Claude Code negotiates; requests carry it in headers and in `_meta`. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** A test API with `/mcp` mounted beside `/api`, as `main.ts` mounts it. */
export async function startTestMcp(
  db: Db,
  configOverrides: Partial<Config> = {},
): Promise<TestApi> {
  const api = await startTestApi(db, undefined, configOverrides);
  api.app.route('/', mcpRoutes(api.ctx));
  return api;
}

type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
};

export type McpReply = {
  status: number;
  headers: Headers;
  /** The JSON-RPC response to the request, or null when the HTTP layer answered on its own. */
  response: JsonRpcMessage | null;
  /** Notifications the server streamed before the response (progress above all). */
  notifications: JsonRpcMessage[];
  /** The parsed body when it was not JSON-RPC (an HTTP-layer error), else null. */
  body: unknown;
};

export type McpCallOptions = {
  /** Extra or overriding headers (a raw `authorization`, say). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Asks for `notifications/progress` under this token. */
  progressToken?: string | number;
  /**
   * The tool call's `arguments` as JSON text, spliced into the body as is: for payloads nested too
   * deep for `JSON.stringify`.
   */
  rawArguments?: string;
};

const RAW_ARGUMENTS = '__raw_arguments__';

/** Anything with Hono's `request` (the test app). */
export type RequestApp = {
  request(path: string, init: RequestInit): Response | Promise<Response>;
};

let nextId = 0;

/** The SSE `data:` payloads in a body, in order; comment frames (keep-alives) are skipped. */
function parseSse(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length > 0) messages.push(JSON.parse(data.join('\n')) as JsonRpcMessage);
  }
  return messages;
}

/** The `/mcp` POST for one JSON-RPC request, as a 2026-07-28 client sends it. */
function requestInit(
  token: string | null,
  method: string,
  params: Record<string, unknown>,
  options: McpCallOptions,
): { id: number; init: RequestInit } {
  nextId += 1;
  const id = nextId;
  const meta: Record<string, unknown> = {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  if (options.progressToken !== undefined) meta.progressToken = options.progressToken;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
  };
  if (method === 'tools/call' && typeof params.name === 'string') headers['mcp-name'] = params.name;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return {
    id,
    init: {
      method: 'POST',
      headers: { ...headers, ...options.headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          ...(options.rawArguments === undefined ? {} : { arguments: RAW_ARGUMENTS }),
          _meta: meta,
        },
      }).replace(`"${RAW_ARGUMENTS}"`, () => options.rawArguments ?? ''),
      signal: options.signal,
    },
  };
}

/**
 * Posts one JSON-RPC request to `/mcp` the way a 2026-07-28 client does: the `_meta` envelope, and
 * the `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name` headers. Reads an SSE
 * or a JSON answer. `token` null sends no `authorization` header.
 */
export async function mcpCall(
  app: RequestApp,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  options: McpCallOptions = {},
): Promise<McpReply> {
  const { id, init } = requestInit(token, method, params, options);
  const res = await app.request('/mcp', init);
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  let messages: JsonRpcMessage[] = [];
  let body: unknown = null;
  if (contentType.includes('text/event-stream')) {
    messages = parseSse(text);
  } else if (text.length > 0) {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'jsonrpc' in parsed) {
      messages = [parsed as JsonRpcMessage];
    } else {
      body = parsed;
    }
  }
  return {
    status: res.status,
    headers: res.headers,
    response: messages.find((m) => m.id === id) ?? null,
    notifications: messages.filter((m) => m.id === undefined),
    body,
  };
}

export type ToolResult<O = Record<string, unknown>> = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: O;
};

/** Calls a tool; throws unless HTTP 200 and a JSON-RPC result. Tool errors come back as results. */
export async function callTool<O = Record<string, unknown>>(
  app: RequestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  options: McpCallOptions = {},
): Promise<ToolResult<O> & { notifications: McpReply['notifications'] }> {
  const reply = await mcpCall(app, token, 'tools/call', { name, arguments: args }, options);
  if (reply.status !== 200 || !reply.response?.result) {
    throw new Error(
      `tools/call ${name} failed: HTTP ${reply.status} ${JSON.stringify(reply.response ?? reply.body)}`,
    );
  }
  return { ...(reply.response.result as ToolResult<O>), notifications: reply.notifications };
}

/** The text of a tool result's text blocks, joined. */
export function resultText(result: ToolResult<unknown>): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/**
 * Opens a `subscriptions/listen` stream and returns the live response without reading it, so a
 * test can hold it open. Cancel its body to close it. `target` is a test app or a live `/mcp` URL.
 */
export async function openListen(target: RequestApp | string, token: string): Promise<Response> {
  nextId += 1;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': 'subscriptions/listen',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId,
      method: 'subscriptions/listen',
      params: {
        notifications: { toolsListChanged: true },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
  return typeof target === 'string' ? fetch(target, init) : target.request('/mcp', init);
}

/**
 * Starts a tool call and returns the live response without reading it, so a test can watch
 * notifications as they arrive (`sseMessages`) or abort the request part-way.
 */
export async function openToolCall(
  app: RequestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  options: McpCallOptions = {},
): Promise<Response> {
  const { init } = requestInit(token, 'tools/call', { name, arguments: args }, options);
  return app.request('/mcp', init);
}

/** The JSON-RPC messages of a live SSE response, each as soon as its frame is complete. */
export async function* sseMessages(response: Response): AsyncGenerator<JsonRpcMessage> {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const message of parseSse(frames.join('\n\n'))) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}
