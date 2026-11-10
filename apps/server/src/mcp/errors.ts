import type { CallToolResult } from '@modelcontextprotocol/server';
import { DomainError, isDomainError } from '../domain/errors';
import {
  LINK_CODE_TTL_SECONDS,
  MAX_LINK_CODES_PER_OWNER,
  MAX_RUNNERS_PER_OWNER,
} from '../domain/runners';
import {
  MAX_BOTS_PER_OWNER,
  MAX_LIVE_GAMES_PER_BOT,
  MAX_PENDING_CHALLENGES,
} from '../domain/limits';

export type ToolErrorResult = CallToolResult & {
  isError: true;
  content: [{ type: 'text'; text: string }];
};

/**
 * Who is reading the error: the owner whose token made the call, or, on the turn surface, the bot
 * the turn is for (with its owner), and the tool called.
 */
export type Viewer = { ownerId: number; botId?: number; tool: string };

const sentence = (message: string): string => {
  const trimmed = message.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

/** What an entry is given: the error, and whether the player it is about is one of the viewer's. */
type Refusal = {
  code: string;
  message: string;
  details: Record<string, unknown>;
  /** null when the error names no player (`details.subjectId` unset). */
  mine: boolean | null;
  /** The subject's display name, or "That bot" when the error carries none. */
  name: string;
};

/** "<message> <hint>": the domain's own sentence, then what to do next. */
const hint =
  (text: string | ((r: Refusal) => string)) =>
  (r: Refusal): string =>
    `${sentence(r.message)} ${typeof text === 'string' ? text : text(r)}`;

/**
 * The agent-facing text for every refusal an agent can meet, keyed by `details.reason`, or by
 * `code` for refusals that carry no reason. Each entry says what went wrong and what to do next.
 * A test holds this to every reason the domain throws (or lists it as never reaching MCP).
 */
export const REFUSALS: Record<string, (r: Refusal) => string> = {
  bot_not_found: hint(
    "Call list_bots for your bots' names and ids. A string is always a name; pass an id as a number.",
  ),
  too_many_link_codes: () =>
    `You have ${MAX_LINK_CODES_PER_OWNER} unused link codes. Use one, or wait for them to expire (${LINK_CODE_TTL_SECONDS / 60} minutes).`,
  too_many_runners: () =>
    `You have the maximum of ${MAX_RUNNERS_PER_OWNER} runners. Call list_runners and revoke one with revoke_runner first.`,
  link_code_invalid: () =>
    'That link code is wrong, already used, or expired. Call link_runner for a new one.',
  runner_not_found: () => 'No such runner. Call list_runners for your runners and their ids.',
  bot_name_taken: hint('Choose a different name.'),
  invalid_bot_name: hint(
    "Names are 1–32 characters: letters, digits, spaces, '.', '_' or '-', starting with a letter or digit.",
  ),
  persona_too_long: hint('Shorten the persona to at most 4,000 characters.'),
  notes_too_long: (r) =>
    `Too long by ${typeof r.details.over === 'number' ? r.details.over : 'some'} characters; shorten and call set_notes again.`,
  notes_changed: (r) =>
    `Another of your games updated these notes. Current notes are below; merge yours in and call set_notes again.\n\n${typeof r.details.current === 'string' ? r.details.current : ''}`,
  invalid_tagline: hint('Taglines are one line of at most 80 characters.'),
  too_many_bots: hint(
    `You have the maximum of ${MAX_BOTS_PER_OWNER} bots. Delete one with delete_bot first.`,
  ),
  owner_not_member: (r) =>
    r.mine === false
      ? `${r.name}'s owner is no longer a member of that group, so it can't play there.`
      : hint('You must be a member of that group. Call list_my_groups for groups you can use.')(r),
  not_a_human_owner: hint("This token's owner can't own bots."),
  blocked: (r) =>
    r.mine === false
      ? `An admin has blocked ${r.name} or its owner in that group.`
      : hint('An admin has blocked this bot or its owner in that group.')(r),
  bot_not_in_group: (r) =>
    r.mine === false
      ? `${r.name} is no longer in that group.`
      : hint('Add the bot to the group with add_bot_to_group first.')(r),
  opponent_gone: (r) => `${r.name} has been deleted.`,
  group_not_found: hint('Use a groupId from list_my_groups.'),
  game_not_found: hint(
    "That bot doesn't play in a game with that id. Use a gameId from get_inbox or get_profile.",
  ),
  // A game the bot doesn't play in reads as no such game: an agent can't probe others' games.
  not_a_player: () =>
    "Game not found. That bot doesn't play in a game with that id. Use a gameId from get_inbox or get_profile.",
  challenge_not_found: hint(
    'That bot has no pending challenge with that id. Use a challengeId from get_inbox.',
  ),
  bots_challenge_bots_only: hint('Bots can only challenge other bots. Find one with find_bots.'),
  open_challenges_are_for_people: () => "Bots can't take open challenges.",
  invalid_cursor: hint(
    'Use the nextCursor from the previous find_bots call with the same sort, or omit it.',
  ),
  opponent_not_found: hint('Use a bot id from find_bots for that group.'),
  self: hint("A bot can't challenge itself. Pick a different bot from find_bots."),
  game_over: hint('Call get_game to see the result, then get_inbox.'),
  pending_limit: hint(
    `This bot already has ${MAX_PENDING_CHALLENGES} pending challenges in this group. Wait for one to be answered or to expire.`,
  ),
  invalid_premove_tree: hint('Fix that node and send the tree again.'),
  premove_too_deep: hint('Shorten that line and send the tree again.'),
  premoves_on_your_turn: () =>
    "It's your bot's move. Set premoves only on the opponent's turn — or pass them with make_move, which takes premoves.",
  too_many_live_games: hint((r) => {
    const limit = typeof r.details.limit === 'number' ? r.details.limit : MAX_LIVE_GAMES_PER_BOT;
    return r.mine === false
      ? `${r.name} already has ${limit} games in progress. Try another bot from find_bots.`
      : `This bot already has ${limit} games in progress. Finish some before starting more.`;
  }),
  too_many_inbox_waits: hint((r) => {
    const limit = typeof r.details.limit === 'number' ? r.details.limit : 2;
    return `You already have ${limit} inbox waits open. Wait for them to return before starting another.`;
  }),
  bot_games_need_clock: hint('Pass a time_per_move.'),
  stale_state: (r) =>
    typeof r.details.plyCount === 'number'
      ? `The position has changed; it is now ply ${r.details.plyCount}. Call get_game and choose again.`
      : `${sentence(r.message)} Call get_game and choose again.`,
  not_your_turn: () =>
    "It isn't your move. Call get_inbox with wait_seconds to wait for your turn.",
  illegal_move: (r) => {
    if (typeof r.details.move !== 'string') return `${sentence(r.message)} Call get_game.`;
    const legal = typeof r.details.legal === 'string' ? ` Legal moves: ${r.details.legal}.` : '';
    return `${r.details.move} isn't legal here.${legal}`;
  },
  not_your_challenge: hint(
    'That challenge is for a different bot. Use a challengeId from get_inbox.',
  ),
  not_the_challenger: hint('Only the bot that made a challenge can withdraw it.'),
  own_challenge: hint("A bot can't accept its own challenge."),
  challenge_gone: hint('Call get_inbox for the challenges still open.'),
  accepted_first: hint('Call get_inbox for the challenges still open.'),
  draw_offer_unavailable: hint('Call get_game to see what the bot can do now.'),
  no_offer: hint('Call get_game to see what the bot can do now.'),
  no_claim: hint('Call get_game to see what the bot can do now.'),
  abort_unavailable: hint('Play on, or resign with game_action.'),
  rate_limited: hint('Wait a minute, then try again.'),
  turn_ended: () => 'This turn has ended; stop.',
  turn_budget_spent: () => 'This session has used its 30 tool calls; stop.',
};

/**
 * Reasons that, when about someone else's player, say only "no such opponent" in `challenge_bot`:
 * an agent must not learn from a challenge whether an id is a person, a deleted bot, or a bot that
 * isn't findable in that group (the same set `find_bots` leaves out).
 */
const UNFINDABLE = new Set(['opponent_gone', 'bot_not_in_group', 'owner_not_member', 'blocked']);

function hidesOpponent(error: DomainError, mine: boolean | null, viewer: Viewer): boolean {
  if (viewer.tool !== 'challenge_bot') return false;
  const reason = error.details.reason;
  // The opponent named a person (or the engine).
  if (reason === 'bots_challenge_bots_only') return true;
  // No such user at all.
  if (error.code === 'not_found' && reason === undefined) return true;
  return typeof reason === 'string' && UNFINDABLE.has(reason) && mine === false;
}

const opponentNotFound = new DomainError('not_found', 'opponent bot not found', {
  reason: 'opponent_not_found',
});

/** The agent-facing text for a domain failure: what went wrong and what to do next. */
export function refusalText(error: DomainError, viewer: Viewer): string {
  const { subjectId, subjectOwnerId, name } = error.details;
  const mine =
    typeof subjectId === 'number'
      ? subjectId === viewer.ownerId ||
        subjectId === viewer.botId ||
        subjectOwnerId === viewer.ownerId
      : null;
  const shown = hidesOpponent(error, mine, viewer) ? opponentNotFound : error;
  const reason = shown.details.reason;
  const entry = (typeof reason === 'string' ? REFUSALS[reason] : undefined) ?? REFUSALS[shown.code];
  if (!entry) return `${sentence(shown.message)} (code: ${shown.code})`;
  return entry({
    code: shown.code,
    message: shown.message,
    details: shown.details,
    mine,
    name: typeof name === 'string' ? name : 'That bot',
  });
}

/**
 * A thrown error as a tool result (`isError: true`), so the agent can read it and recover. Only a
 * `DomainError` says what happened; anything else is a generic message (the caller logs it).
 */
export function toolError(error: unknown, viewer: Viewer): ToolErrorResult {
  const text = isDomainError(error)
    ? refusalText(error, viewer)
    : 'Something went wrong on the Chess Goat server. Try again in a moment.';
  return { isError: true, content: [{ type: 'text', text }] };
}
