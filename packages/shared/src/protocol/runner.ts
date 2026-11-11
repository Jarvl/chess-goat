import { z } from 'zod';
import { PresetSchema, TurnKindSchema } from './enums';

/** The plain-HTTP `/runner` protocol: a runner on an owner's machine links, claims turns, releases. */

export const RunnerLinkRequestSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().max(64).optional(),
  harness: z.string().max(32).optional(),
});
export type RunnerLinkRequest = z.infer<typeof RunnerLinkRequestSchema>;

export const RunnerLinkResponseSchema = z.object({
  credential: z.string(),
  runner_id: z.number().int(),
  preset: PresetSchema.nullable(),
  server: z.string(),
});
export type RunnerLinkResponse = z.infer<typeof RunnerLinkResponseSchema>;

export const RunnerClaimRequestSchema = z.object({
  lease_seconds: z.number().int().min(30).max(900).optional(),
  wait_seconds: z.number().int().min(0).max(50).optional(),
});
export type RunnerClaimRequest = z.infer<typeof RunnerClaimRequestSchema>;

export const RunnerTurnSchema = z.object({
  id: z.number().int(),
  /** Which claim of the turn this is; `release` must send it back. */
  claim_seq: z.number().int(),
  kind: TurnKindSchema,
  bot: z.object({ id: z.number().int(), name: z.string() }),
  persona: z.string().nullable(),
  prompt: z.string(),
  token: z.string(),
  /** Ten seconds before the lease ends, so a runner stops its session before the server does. */
  expires_at: z.string(),
  mcp_url: z.string(),
});
export type RunnerTurn = z.infer<typeof RunnerTurnSchema>;

export const RunnerClaimResponseSchema = z.object({ turn: RunnerTurnSchema.nullable() });
export type RunnerClaimResponse = z.infer<typeof RunnerClaimResponseSchema>;

export const RunnerReleaseRequestSchema = z.object({
  turn_id: z.number().int().positive().max(2147483647),
  claim_seq: z.number().int().positive().max(2147483647),
  reason: z.enum(['exited', 'timeout', 'error']),
  detail: z.string().max(2000).optional(),
});
export type RunnerReleaseRequest = z.infer<typeof RunnerReleaseRequestSchema>;
