import { z } from 'zod';
import { MAX_WORN_FLAIR } from '../flair/catalog';
import { GroupSettingsSchema, PrefsSchema, PremoveTreeTextSchema, UciSchema } from './dto';
import { ColourChoiceSchema, EngineLevelSchema, TimePerMoveSchema } from './enums';
import { UserIdSchema } from './ids';

export const LaunchRequestSchema = z.object({
  initData: z.string().min(1).max(4096),
  /**
   * The `startapp` query of a `web_app` button's URL, for launches whose initData has no
   * `start_param`. Unsigned, which is fine: it only picks the landing screen, and every screen
   * checks access itself.
   */
  startParam: z.string().max(64).optional(),
});

export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

export const MoveRequestSchema = z.object({
  uci: UciSchema,
  expectedPly: z.number().int().min(0),
  /** Client-generated id reused on retries so a move is applied at most once (spec §7.4). */
  clientMoveId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** The mover's premove tree for the position after this move, saved with the move; `''` when none. */
  premoveTree: PremoveTreeTextSchema.default(''),
});

export type MoveRequest = z.infer<typeof MoveRequestSchema>;

/** Compare-and-set of the viewer's premove tree: `baseHash` fingerprints the tree the device showed. */
export const PremoveTreeRequestSchema = z.object({
  baseHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  tree: PremoveTreeTextSchema,
  expectedPly: z.number().int().min(0),
});

export type PremoveTreeRequest = z.infer<typeof PremoveTreeRequestSchema>;

export const ChallengeRequestSchema = z.object({
  /** null for an open challenge. */
  opponentId: UserIdSchema.nullable(),
  timePerMove: TimePerMoveSchema,
  colour: ColourChoiceSchema,
  rated: z.boolean(),
});

export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

/**
 * Starts a game against the bot. Two fields the challenge request has are deliberately absent:
 * `rated`, because the domain layer forces it false (spec §6.1), and `timePerMove`, because a bot
 * game has no clock at all — the bot answers immediately, so a per-move deadline protects nobody and
 * could only lose a casual game to inattention (spec §8).
 */
export const EngineGameRequestSchema = z.object({
  level: EngineLevelSchema,
  colour: ColourChoiceSchema,
});

export type EngineGameRequest = z.infer<typeof EngineGameRequestSchema>;

export const ShareRequestSchema = z.object({
  ply: z.number().int().min(0),
});

export type ShareRequest = z.infer<typeof ShareRequestSchema>;

export const PrefsUpdateRequestSchema = z.object({
  prefs: PrefsSchema.partial().optional(),
  writeAccess: z.object({ allowed: z.boolean() }).optional(),
});

export type PrefsUpdateRequest = z.infer<typeof PrefsUpdateRequestSchema>;

export const GroupSettingsUpdateRequestSchema = GroupSettingsSchema.partial();

export type GroupSettingsUpdateRequest = z.infer<typeof GroupSettingsUpdateRequestSchema>;

export const BlockRequestSchema = z.object({
  userId: UserIdSchema,
});

export type BlockRequest = z.infer<typeof BlockRequestSchema>;

export const TelemetryRequestSchema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(['launch_failed', 'move_retry', 'sse_failed']),
        code: z.string().max(64).optional(),
        durationMs: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export type TelemetryRequest = z.infer<typeof TelemetryRequestSchema>;

export const FinishedQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
});

export type FinishedQuery = z.infer<typeof FinishedQuerySchema>;

/** Tip jar spec §2.1: whole Stars, one invoice per tap. */
export const TIP_MIN_STARS = 1;
export const TIP_MAX_STARS = 10_000;

export const TipRequestSchema = z.object({
  stars: z.number().int().min(TIP_MIN_STARS).max(TIP_MAX_STARS),
});

export type TipRequest = z.infer<typeof TipRequestSchema>;

/**
 * Flair spec §4: the worn ids in slot order. The server also refuses duplicates, ids the catalog
 * does not have and ids the caller has not earned, all with `validation`.
 */
export const FlairUpdateRequestSchema = z.object({
  worn: z.array(z.string()).max(MAX_WORN_FLAIR),
});

export type FlairUpdateRequest = z.infer<typeof FlairUpdateRequestSchema>;
