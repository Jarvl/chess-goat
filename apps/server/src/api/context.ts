import type { Api } from 'grammy';
import type { RateLimiter } from '../bot/rateLimit';
import type { Config } from '../config';
import type { UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';
import type { Metrics } from '../metrics';
import type { Membership } from '../telegram/membership';
import type { StreamGate } from './streams';

export type ApiContext = {
  deps: Deps;
  config: Config;
  membership: Membership;
  metrics: Metrics;
  streams: StreamGate;
  /** 120 API requests per user per minute; one instance per process. */
  rateLimiter: RateLimiter;
  /** The throttled Bot API client, for the calls a request makes itself. */
  api: Api;
  /** Ten invoice links per user per minute. */
  tipLimiter: RateLimiter;
};

export type ApiEnv = { Variables: { user: UserRow } };
