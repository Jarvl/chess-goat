import {
  PrefsUpdateRequestSchema,
  TelemetryRequestSchema,
  type OkDto,
  type OwnerTokenCreatedDto,
  type OwnerTokenStatusDto,
  type Prefs,
} from '@chess-goat/shared';
import { Hono } from 'hono';
import { RateLimiter } from '../../bot/rateLimit';
import { deleteMyData } from '../../domain/account';
import { DomainError } from '../../domain/errors';
import { meGames, meGroups } from '../../domain/lobby';
import { createOwnerToken, ownerTokenStatus, revokeOwnerToken } from '../../domain/ownerTokens';
import { prefsOf, recordWriteAccess, requireUser, updatePrefs } from '../../domain/users';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

const OK: OkDto = { ok: true };

export function meRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const telemetryLimiter = new RateLimiter(10, 60_000);
  const ownerTokenLimiter = new RateLimiter(5, 60_000);

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

  app.get('/me/owner-token', async (c) => {
    const found = await ownerTokenStatus(ctx.deps.db, c.get('user').id);
    const dto: OwnerTokenStatusDto = {
      token: found
        ? {
            createdAt: found.createdAt.toISOString(),
            lastUsedAt: found.lastUsedAt?.toISOString() ?? null,
          }
        : null,
    };
    return c.json(dto);
  });

  app.post('/me/owner-token', async (c) => {
    const user = c.get('user');
    if (!ownerTokenLimiter.allow(`owner-token:${user.id}`))
      throw new DomainError('rate_limited', 'too many owner token requests');
    const dto = await ctx.deps.db.transaction(async (tx): Promise<OwnerTokenCreatedDto> => {
      const token = await createOwnerToken(tx, user.id);
      const found = await ownerTokenStatus(tx, user.id);
      return { token, createdAt: found!.createdAt.toISOString() };
    });
    return c.json(dto);
  });

  app.delete('/me/owner-token', async (c) => {
    await ctx.deps.db.transaction((tx) => revokeOwnerToken(tx, c.get('user').id));
    return c.json(OK);
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
