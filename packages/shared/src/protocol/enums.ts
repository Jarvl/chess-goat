import { z } from 'zod';

/** Time per move in seconds. `null` means the game has no clock. */
export const TIME_PER_MOVE_OPTIONS = [3600, 28800, 86400, 259200, 604800] as const;

export type TimePerMoveSeconds = (typeof TIME_PER_MOVE_OPTIONS)[number];

export const TimePerMoveSchema = z.union([
  z.literal(3600),
  z.literal(28800),
  z.literal(86400),
  z.literal(259200),
  z.literal(604800),
  z.null(),
]);

export type TimePerMove = z.infer<typeof TimePerMoveSchema>;

export const ColourSchema = z.enum(['white', 'black']);

export type Colour = z.infer<typeof ColourSchema>;

export function opposite(colour: Colour): Colour {
  return colour === 'white' ? 'black' : 'white';
}

/** The colour a challenger asks for; `random` is settled by a coin flip on accept. */
export const ColourChoiceSchema = z.enum(['white', 'black', 'random']);

export type ColourChoice = z.infer<typeof ColourChoiceSchema>;

export const GameStatusSchema = z.enum(['active', 'finished']);

export type GameStatus = z.infer<typeof GameStatusSchema>;

/** PGN result tokens. `*` marks an unfinished, aborted or voided game. */
export const GameResultSchema = z.enum(['1-0', '0-1', '1/2-1/2', '*']);

export type GameResult = z.infer<typeof GameResultSchema>;

export const EndReasonSchema = z.enum([
  'checkmate',
  'stalemate',
  'insufficient_material',
  'fivefold_repetition',
  'seventy_five_moves',
  'threefold_claim',
  'fifty_move_claim',
  'draw_agreement',
  'resignation',
  'timeout',
  'timeout_abort',
  'abort',
  'voided',
]);

export type EndReason = z.infer<typeof EndReasonSchema>;

/** End reasons that change ratings. Aborts and voids never do. */
const RATED_END_REASONS: ReadonlySet<EndReason> = new Set<EndReason>([
  'checkmate',
  'stalemate',
  'insufficient_material',
  'fivefold_repetition',
  'seventy_five_moves',
  'threefold_claim',
  'fifty_move_claim',
  'draw_agreement',
  'resignation',
  'timeout',
]);

export function isRatedEndReason(reason: EndReason): boolean {
  return RATED_END_REASONS.has(reason);
}

export const ChallengeStatusSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
]);

export type ChallengeStatus = z.infer<typeof ChallengeStatusSchema>;

/**
 * Player Kind: what sort of player a user is. A person; the engine (the built-in Stockfish
 * opponent); or a bot, owned by a person and driven by their agent over MCP.
 */
export const PlayerKindSchema = z.enum(['human', 'engine', 'bot']);

export type PlayerKind = z.infer<typeof PlayerKindSchema>;

export const ViewerRoleSchema = z.enum(['white', 'black', 'spectator']);

export type ViewerRole = z.infer<typeof ViewerRoleSchema>;

/** Engine opponent strength, weakest first. No rating numbers here — see the engine config. */
export const ENGINE_LEVELS = ['beginner', 'casual', 'club', 'strong'] as const;

export type EngineLevel = (typeof ENGINE_LEVELS)[number];

export const EngineLevelSchema = z.enum(ENGINE_LEVELS);

/** When a dropped move waits for Confirm move (move confirmations spec). */
export const MOVE_CONFIRMATIONS = ['always', 'people', 'never'] as const;

export type MoveConfirmations = (typeof MOVE_CONFIRMATIONS)[number];

export const MoveConfirmationsSchema = z.enum(MOVE_CONFIRMATIONS);
