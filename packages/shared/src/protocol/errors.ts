import { z } from 'zod';

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'stale_state',
  'not_your_turn',
  'illegal_move',
  'expired',
  'limit_exceeded',
  'rate_limited',
  'validation',
  /** An unhandled server error; not a domain outcome, the app treats it like a network failure. */
  'internal',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Which refusal of a `code` it was (`too_many_live_games`, `announce_limit`…), when it matters. */
    reason: z.string().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** HTTP status per code. The board treats every 409 as "reload the state and snap back". */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  stale_state: 409,
  not_your_turn: 409,
  expired: 409,
  limit_exceeded: 409,
  illegal_move: 422,
  rate_limited: 429,
  validation: 400,
  internal: 500,
};

export function apiErrorBody(code: ErrorCode, message: string, reason?: string): ApiErrorBody {
  return { error: reason === undefined ? { code, message } : { code, message, reason } };
}
