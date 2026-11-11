import type { RunnerTurn } from '@chess-goat/shared';
import { abortError, networkDetail, readLimited } from '../http.js';
import { createMcpClient, McpError } from '../mcpClient.js';
import type { SessionResult } from '../session.js';
import { DEFAULT_PERSONA } from './common.js';

// The lean preset: the runner itself drives a small local model through an OpenAI-compatible
// chat-completions endpoint, calling Chess Goat's MCP tools for it. Limitation: some local models
// write a tool call as plain text instead of `tool_calls`; that is not parsed here and ends the
// loop as "no tool call".
// A failed MCP call that throws (network error, 5xx, 401) ends the turn as `error`; the model is
// not told. A tool that merely answers with an error result is passed back to the model.
// `tail` leaves the process, so it holds fixed text and counts only: never model text, tool
// arguments or results, a persona, a prompt, the token or the API key.

export type LeanOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  fetch?: typeof fetch;
};

const MODEL_TIMEOUT_MS = 10 * 60_000;
const MODEL_BODY_MAX = 2 * 1024 * 1024;
const TOOL_TEXT_MAX = 16_000;
const CALL_BUDGET = 30;
const TURN_ENDED = 'This turn has ended; stop.';
const CALLS_USED = 'This session has used its 30 tool calls; stop.';
const UNKNOWN_TOOL = '(unknown tool)';

class LeanError extends Error {}

type ToolCall = { id: string; name: unknown; arguments: unknown };

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

/** The message text: a string, or the text parts of an array of parts; null otherwise. */
function contentOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((p) => {
    const part = p as { type?: unknown; text?: unknown } | null;
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join('') : null;
}

/** Arguments as the model sent them: a JSON string, or (some servers) already an object. */
function parseArguments(raw: unknown): 'bad-json' | 'not-object' | { value: object } {
  if (raw === undefined || raw === null || raw === '') return { value: {} };
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return 'bad-json';
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { value }
    : 'not-object';
}

/** The parameters schema as sent to the model: some llama.cpp-based servers reject `$schema`. */
function parametersOf(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
  return rest;
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
  let steps = 0;
  let stopped: string | undefined;

  const tail = (extra?: string) =>
    extra ??
    [`steps: ${steps}; tool calls: ${calls.length > 0 ? calls.join(', ') : 'none'}`, stopped]
      .filter((p) => p !== undefined)
      .join('\n');
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
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: parametersOf(t.inputSchema),
      },
    }));
    const messages: unknown[] = [
      { role: 'system', content: turn.persona ?? DEFAULT_PERSONA },
      { role: 'user', content: turn.prompt },
    ];

    stopped = 'stopped: step limit';
    for (let step = 0; step < maxSteps; step++) {
      const message = await chat(messages, tools);
      steps++;
      const toolCalls = toolCallsOf(message);
      // Echo a normalised message, not the server's object: strings for arguments, our own ids.
      messages.push({
        role: 'assistant',
        content: contentOf(message.content),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: {
                  name: typeof c.name === 'string' ? c.name : '',
                  arguments:
                    typeof c.arguments === 'string'
                      ? c.arguments
                      : JSON.stringify(c.arguments ?? {}),
                },
              })),
            }
          : {}),
      });
      if (toolCalls.length === 0) {
        stopped = 'stopped: no tool call';
        break;
      }

      for (const call of toolCalls) {
        if (signal.aborted) throw abortError();
        const name = typeof call.name === 'string' ? call.name : '';
        const known = names.has(name);
        const args = parseArguments(call.arguments);
        let content: string;
        let ok = false;
        if (!known) {
          content = `No such tool. Use one of: ${[...names].join(', ')}.`;
        } else if (args === 'bad-json') {
          content = 'Your arguments were not valid JSON.';
        } else if (args === 'not-object') {
          content = 'Your arguments must be a JSON object.';
        } else {
          const result = await mcp.callTool(name, args.value);
          content = result.text;
          ok = !result.isError;
        }
        calls.push(`${known ? name : UNKNOWN_TOOL} ${ok ? 'ok' : 'failed'}`);
        anyOk ||= ok;
        const ended = content.includes(TURN_ENDED)
          ? 'stopped: turn ended'
          : content.includes(CALLS_USED) || calls.length >= CALL_BUDGET
            ? 'stopped: call limit'
            : undefined;
        if (content === '') content = '(no text)';
        else if (content.length > TOOL_TEXT_MAX)
          content = `${content.slice(0, TOOL_TEXT_MAX)}… (cut)`;
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        if (ended) {
          stopped = ended;
          return done('exited', anyOk ? 0 : 1);
        }
      }
    }
    return done('exited', anyOk ? 0 : 1);
  } catch (error) {
    if (signal.aborted) {
      stopped = undefined; // the step-limit default does not apply to an abort
      return done('timeout', null);
    }
    if (error instanceof LeanError || error instanceof McpError) {
      return done('error', null, error.message);
    }
    return done('error', null, 'the lean session failed unexpectedly');
  }
}
