import { apiErrorBody, HTTP_STATUS_BY_ERROR_CODE } from '@chess-goat/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { StatusCode } from 'hono/utils/http-status';
import { isDomainError } from '../domain/errors';
import type { ApiContext, ApiEnv } from './context';
import { requireSession, userRateLimit } from './middleware';
import { avatarRoutes } from './routes/avatars';
import { healthRoutes } from './routes/health';
import { launchRoutes } from './routes/launch';
import { meRoutes } from './routes/me';

export type RegisterRoutes = (api: Hono<ApiEnv>, ctx: ApiContext) => void;

/** The HTTP app: health and metrics at the root, everything else under /api behind a session. */
export function createApiApp(ctx: ApiContext, extra: RegisterRoutes[] = []): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    if (isDomainError(error)) {
      const status = HTTP_STATUS_BY_ERROR_CODE[error.code] as StatusCode;
      c.status(status as 400);
      return c.json(apiErrorBody(error.code, error.message));
    }
    if (error instanceof HTTPException) {
      // Framework rejections (the body limit above all) keep their status in the spec's error shape.
      c.status(error.status);
      const code = error.status === 413 ? 'validation' : 'internal';
      return c.json(apiErrorBody(code, error.message || 'request rejected'));
    }
    ctx.deps.log.error({ err: error, path: c.req.path }, 'unhandled request error');
    // Spec §14 wants launch failures counted; the client has no session to report one with, so
    // the API-side half is counted here.
    if (c.req.path === '/api/launch') ctx.metrics.miniappLoadErrors.inc();
    c.status(500);
    return c.json(apiErrorBody('internal', 'internal error'));
  });

  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.route('/', healthRoutes(ctx));

  const api = new Hono<ApiEnv>();
  api.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  api.route('/', launchRoutes(ctx));
  api.route('/', avatarRoutes(ctx));
  api.use('*', requireSession(ctx));
  api.use('*', userRateLimit(ctx));
  api.route('/', meRoutes(ctx));
  for (const register of extra) register(api, ctx);
  app.route('/api', api);
  return app;
}
