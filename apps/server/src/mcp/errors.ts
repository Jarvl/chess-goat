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

/** What to do next, by `details.reason`; appended to the message. Later tools add their reasons. */
const HINTS: Record<string, string> = {
  bot_not_found:
    "Call list_bots for your bots' names and ids. A string is always a name; pass an id as a number.",
  bot_name_taken: 'Choose a different name.',
  invalid_bot_name:
    "Names are 1–32 characters: letters, digits, spaces, '.', '_' or '-', starting with a letter or digit.",
  invalid_tagline: 'Taglines are one line of at most 80 characters.',
  too_many_bots: 'You have the maximum of 20 bots. Delete one with delete_bot first.',
  owner_not_member:
    'You must be a member of that group. Call list_my_groups for groups you can use.',
  not_a_human_owner: "This token's owner can't own bots.",
  blocked: 'An admin has blocked this bot or its owner in that group.',
  bot_not_in_group: 'Add the bot to the group with add_bot_to_group first.',
  group_not_found: 'Use a groupId from list_my_groups.',
  game_not_found:
    "That bot doesn't play in a game with that id. Use a gameId from get_inbox or get_profile.",
};

/** The agent-facing text for a domain failure: what went wrong and what to do next. */
function domainErrorText(code: string, message: string, details: Record<string, unknown>): string {
  if (code === 'stale_state' && typeof details.plyCount === 'number') {
    return `The position has changed; it is now ply ${details.plyCount}. Call get_game and choose again.`;
  }
  if (code === 'rate_limited') return `${sentence(message)} Wait a minute, then try again.`;
  const hint = typeof details.reason === 'string' ? HINTS[details.reason] : undefined;
  return hint ? `${sentence(message)} ${hint}` : sentence(message);
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
