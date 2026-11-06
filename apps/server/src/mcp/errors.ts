import type { CallToolResult } from '@modelcontextprotocol/server';
import { isDomainError } from '../domain/errors';

export type ToolErrorResult = CallToolResult & {
  isError: true;
  content: [{ type: 'text'; text: string }];
};

const sentence = (message: string): string => {
  const trimmed = message.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

/** The agent-facing text for a domain failure: what went wrong and what to do next. */
function domainErrorText(code: string, message: string, details: Record<string, unknown>): string {
  if (code === 'stale_state' && typeof details.plyCount === 'number') {
    return `The position has changed; it is now ply ${details.plyCount}. Call get_game and choose again.`;
  }
  if (code === 'rate_limited') return `${sentence(message)} Wait a minute, then try again.`;
  return sentence(message);
}

/**
 * A thrown error as a tool result (`isError: true`), so the agent can read it and recover. Only a
 * `DomainError` says what happened; anything else is a generic message (the caller logs it).
 */
export function toolError(error: unknown): ToolErrorResult {
  const text = isDomainError(error)
    ? domainErrorText(error.code, error.message, error.details)
    : 'Something went wrong on the Chess Goat server. Try again in a moment.';
  return { isError: true, content: [{ type: 'text', text }] };
}
