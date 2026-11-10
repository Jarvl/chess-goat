import pino from 'pino';
import type { Config } from './config';

export type Logger = pino.Logger;

/** Drizzle embeds bound parameters in query errors; they may be names, so they never reach a log. */
const BOUND_PARAMS = /\nparams: [^\n]*/g;

/**
 * The only error fields a log keeps. Anything else is dropped: grammY's `BotError.ctx` carries the
 * bot token, the whole update and the user's name, and Drizzle's `params`/`query` carry bound values.
 */
const ERROR_FIELDS = ['type', 'message', 'stack', 'code'] as const;
/** Wrapped errors: `cause`, and grammY's `BotError.error` (the handler's own failure). */
const NESTED_ERRORS = ['cause', 'error'] as const;

function sanitiseError(error: unknown): Record<string, unknown> {
  // Nested errors arrive already serialised by pino; serialising them again would lose their type.
  const serialised = (error instanceof Error ? pino.stdSerializers.err(error) : error) as Record<
    string,
    unknown
  >;
  const safe: Record<string, unknown> = {};
  for (const key of ERROR_FIELDS) {
    const value = serialised[key];
    if (typeof value === 'string') safe[key] = value.replace(BOUND_PARAMS, '');
    else if (typeof value === 'number') safe[key] = value;
  }
  for (const key of NESTED_ERRORS) {
    const nested = serialised[key];
    if (nested && typeof nested === 'object') safe[key] = sanitiseError(nested);
  }
  return safe;
}

/** JSON logs with numeric and public ids only. */
export function createLogger(
  level: Config['LOG_LEVEL'] = 'info',
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: undefined,
    serializers: { err: sanitiseError },
  };
  return destination ? pino(options, destination) : pino(options);
}
