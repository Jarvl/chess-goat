import type { RunnerTurn } from '@chess-goat/shared';
import { abortError, createMcpClient, McpError, networkDetail, readLimited } from '../mcpClient.js';
import type { SessionResult } from '../session.js';
import { DEFAULT_PERSONA } from './common.js';

// The lean preset: the runner itself drives a small local model through an OpenAI-compatible
// chat-completions endpoint, calling Chess Goat's MCP tools for it. Limitation: some local models
// write a tool call as plain text instead of `tool_calls`; that is not parsed here and ends the
// loop as "no tool call".

export type LeanOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  fetch?: typeof fetch;
};

const MODEL_TIMEOUT_MS = 10 * 60_000;
const MODEL_BODY_MAX = 2 * 1024 * 1024;
const TAIL_MAX = 2000;
const NAME_MAX = 64;
const TURN_ENDED = 'This turn has ended; stop.';
const CALLS_USED = 'This session has used its 30 tool calls; stop.';

class LeanError extends Error {}

type ToolCall = { id: string; name: unknown; arguments: unknown };

const clean = (text: string, max: number) =>
  Array.from(text, (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);

function toolCallsOf(message: Record<string, unknown>): ToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((raw, i) => {
    const call = (raw ?? {}) as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    return {
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${i}`,
      name: call.function?.name,
      arguments: call.function?.arguments,
    };
  });
}

/** Arguments as the model sent them: a JSON string, or (some servers) already an object. */
function parseArguments(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} };
  if (typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false };
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function runLeanTurn(
  turn: RunnerTurn,
  opts: LeanOptions,
  signal: AbortSignal,
): Promise<SessionResult> {
  const started = Date.now();
  const doFetch = opts.fetch ?? fetch;
  const maxSteps = opts.maxSteps ?? 12;
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const calls: string[] = [];
  let anyOk = false;
  let lastText = '';

  const tail = (extra?: string) => {
    const parts = [
      extra,
      calls.length > 0 ? `tools: ${calls.join(', ')}` : undefined,
      lastText !== '' ? `last assistant text: ${clean(lastText, TAIL_MAX)}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return parts.join('\n').slice(0, TAIL_MAX);
  };
  const done = (reason: SessionResult['reason'], exitCode: number | null, extra?: string) => ({
    reason,
    exitCode,
    tail: tail(extra),
    ms: Date.now() - started,
  });

  async function chat(messages: unknown[], tools: unknown[]): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    let status: number;
    let text: string | null = '';
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model,
          messages,
          tools,
          tool_choice: 'auto',
          stream: false,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
        redirect: 'manual',
      });
      status = res.status;
      if (status < 200 || status > 299) {
        await res.body?.cancel().catch(() => {});
      } else {
        text = await readLimited(res, MODEL_BODY_MAX);
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw new LeanError(`could not reach the model endpoint: ${networkDetail(error)}`);
    }
    if (status >= 300 && status <= 399) {
      throw new LeanError(`the model endpoint redirected (HTTP ${status}); check baseUrl`);
    }
    if (status < 200 || status > 299) {
      throw new LeanError(`the model endpoint answered HTTP ${status}; check baseUrl and model`);
    }
    if (text === null) throw new LeanError('the model endpoint sent too large a response');
    let message: unknown;
    try {
      message = (JSON.parse(text) as { choices?: { message?: unknown }[] }).choices?.[0]?.message;
    } catch {
      message = undefined;
    }
    if (!message || typeof message !== 'object') {
      throw new LeanError('the model endpoint sent a response with no message');
    }
    return message as Record<string, unknown>;
  }

  try {
    const mcp = createMcpClient(turn.mcp_url, turn.token, { fetch: opts.fetch, signal });
    const listed = await mcp.listTools();
    const names = new Set(listed.map((t) => t.name));
    const tools = listed.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
    }));
    const messages: unknown[] = [
      { role: 'system', content: turn.persona ?? DEFAULT_PERSONA },
      { role: 'user', content: turn.prompt },
    ];

    for (let step = 0; step < maxSteps; step++) {
      const message = await chat(messages, tools);
      messages.push(message);
      if (typeof message.content === 'string' && message.content !== '') lastText = message.content;
      const toolCalls = toolCallsOf(message);
      if (toolCalls.length === 0) break;

      for (const call of toolCalls) {
        if (signal.aborted) throw abortError();
        const name = typeof call.name === 'string' ? call.name : '';
        const label = clean(name, NAME_MAX) || '(unnamed)';
        let content: string;
        let ok = false;
        const args = parseArguments(call.arguments);
        if (!names.has(name)) {
          content = `No such tool. Use one of: ${[...names].join(', ')}.`;
        } else if (!args.ok) {
          content = 'Your arguments were not valid JSON.';
        } else {
          const result = await mcp.callTool(name, args.value);
          content = result.text;
          ok = !result.isError;
        }
        calls.push(`${label} ${ok ? 'ok' : 'failed'}`);
        anyOk ||= ok;
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        if (content.includes(TURN_ENDED) || content.includes(CALLS_USED)) {
          return done('exited', anyOk ? 0 : 1);
        }
      }
    }
    return done('exited', anyOk ? 0 : 1);
  } catch (error) {
    if (signal.aborted) return done('timeout', null);
    if (error instanceof LeanError || error instanceof McpError) {
      return done('error', null, error.message);
    }
    return done('error', null, 'the lean session failed unexpectedly');
  }
}
