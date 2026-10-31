import {
  PrefsUpdateRequestSchema,
  TelemetryRequestSchema,
  type OkDto,
  type Prefs,
} from '@chess-goat/shared';
import { Hono } from 'hono';
import { RateLimiter } from '../../bot/rateLimit';
import { deleteMyData } from '../../domain/account';
import { DomainError } from '../../domain/errors';
import { meGames, meGroups } from '../../domain/lobby';
import { prefsOf, recordWriteAccess, requireUser, updatePrefs } from '../../domain/users';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

const OK: OkDto = { ok: true };

export function meRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const telemetryLimiter = new RateLimiter(10, 60_000);

  app.get('/me/groups', async (c) => c.json(await meGroups(ctx.deps, c.get('user').id)));

  app.get('/me/games', async (c) => c.json(await meGames(ctx.deps, c.get('user').id)));

  app.put('/me/prefs', validate('json', PrefsUpdateRequestSchema), async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');
    let prefs: Prefs = prefsOf(user);
    if (body.prefs) prefs = await updatePrefs(ctx.deps.db, user.id, body.prefs);
    if (body.writeAccess) await recordWriteAccess(ctx.deps.db, user.id, body.writeAccess.allowed);
    const fresh = await requireUser(ctx.deps.db, user.id);
    return c.json({ prefs, dmAllowed: fresh.dmAllowed });
  });

  app.delete('/me', async (c) => {
    await deleteMyData(ctx.deps, c.get('user').id);
    return c.json(OK);
  });

  app.post('/telemetry', validate('json', TelemetryRequestSchema), async (c) => {
    const user = c.get('user');
    if (!telemetryLimiter.allow(`telemetry:${user.id}`))
      throw new DomainError('rate_limited', 'too much telemetry');
    for (const event of c.req.valid('json').events) {
      if (event.kind === 'launch_failed') ctx.metrics.miniappLoadErrors.inc();
      if (event.kind === 'move_retry') ctx.metrics.miniappMoveFailures.inc();
      ctx.deps.log.info(
        { kind: event.kind, code: event.code, durationMs: event.durationMs, userId: user.id },
        'client telemetry',
      );
    }
    return c.json(OK);
  });

  return app;
}
