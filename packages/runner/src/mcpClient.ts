// A tiny MCP client for Chess Goat's turn surface: tools/list and tools/call over plain HTTP,
// speaking the dialect the server's own test helper does. Errors carry fixed text plus a status
// or code, never a body, header or the token.

export type McpTool = { name: string; description?: string; inputSchema: unknown };

export const MCP_PROTOCOL_VERSION = '2026-07-28';

const MCP_TIMEOUT_MS = 30_000;
const MCP_BODY_MAX = 1024 * 1024;

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

/** The body as text, or null when it is longer than `limit` bytes (the rest is cancelled). */
export async function readLimited(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A fixed phrase for why a request failed; never the error's own text. */
export function networkDetail(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth++) {
    const code = (node as { code?: unknown }).code;
    if (code === 'ECONNREFUSED') return 'connection refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
    if (code === 'ECONNRESET') return 'connection reset';
    node = (node as { cause?: unknown }).cause;
  }
  return 'connection failed';
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

type RpcMessage = { id?: unknown; result?: unknown; error?: { code?: unknown } };

/** The JSON-RPC messages of an SSE body (`data:` lines of each frame; comments skipped). */
function parseSse(text: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length === 0) continue;
    try {
      out.push(JSON.parse(data.join('\n')) as RpcMessage);
    } catch {
      // a frame that is not JSON is not ours
    }
  }
  return out;
}

export function createMcpClient(
  url: string,
  token: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const doFetch = opts.fetch ?? fetch;
  let nextId = 0;

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    nextId += 1;
    const id = nextId;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': method,
      authorization: `Bearer ${token}`,
    };
    if (method === 'tools/call' && typeof params.name === 'string') {
      headers['mcp-name'] = params.name;
    }
    const timeout = AbortSignal.timeout(MCP_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let status: number;
    let text: string | null;
    let contentType: string;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        signal,
        redirect: 'manual',
      });
      status = res.status;
      contentType = res.headers.get('content-type') ?? '';
      if (status < 200 || status > 299) {
        await res.body?.cancel().catch(() => {});
        text = '';
      } else {
        text = await readLimited(res, MCP_BODY_MAX);
      }
    } catch (error) {
      if (opts.signal?.aborted) throw abortError();
      throw new McpError(`could not reach the MCP server: ${networkDetail(error)}`);
    }
    if (status < 200 || status > 299) {
      throw new McpError(
        status >= 300 && status <= 399
          ? `the MCP server redirected (HTTP ${status}); check the MCP URL`
          : `the MCP server answered HTTP ${status}`,
      );
    }
    if (text === null) throw new McpError('the MCP server sent too large a response');
    let messages: RpcMessage[];
    if (contentType.includes('text/event-stream')) {
      messages = parseSse(text);
    } else {
      try {
        messages = [JSON.parse(text) as RpcMessage];
      } catch {
        messages = [];
      }
    }
    const reply = messages.find((m) => m && m.id === id && ('result' in m || 'error' in m));
    if (!reply) throw new McpError('the MCP server sent an unusable response');
    if (reply.error) {
      const code = typeof reply.error.code === 'number' ? reply.error.code : 'unknown';
      throw new McpError(`the MCP server returned JSON-RPC error ${code}`);
    }
    return reply.result;
  }

  return {
    async listTools(): Promise<McpTool[]> {
      const result = (await rpc('tools/list', {})) as { tools?: unknown } | null;
      const tools = Array.isArray(result?.tools) ? (result.tools as unknown[]) : [];
      return tools.flatMap((t) => {
        const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool?.name !== 'string') return [];
        return [
          {
            name: tool.name,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          },
        ];
      });
    },

    async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
      const result = (await rpc('tools/call', { name, arguments: args })) as {
        content?: unknown;
        isError?: unknown;
      } | null;
      const parts = Array.isArray(result?.content) ? (result.content as unknown[]) : [];
      const text = parts
        .flatMap((p) => {
          const part = p as { type?: unknown; text?: unknown };
          return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        })
        .join('\n');
      return { text, isError: result?.isError === true };
    },
  };
}
