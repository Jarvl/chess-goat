import { decodeStartParam, LaunchRequestSchema, type LaunchResponse } from '@chess-goat/shared';
import { Hono } from 'hono';
import { dbNow } from '../../db/client';
import { DomainError } from '../../domain/errors';
import { yourMoveTotal } from '../../domain/lobby';
import { displayName, ensureUser, prefsOf, setDmAllowed } from '../../domain/users';
import type { ApiContext, ApiEnv } from '../context';
import { validateInitData } from '../initData';
import { resolveLaunchRoute } from '../launchRoute';
import { issueSessionToken } from '../session';
import { validate } from '../validate';

export function launchRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.post('/launch', validate('json', LaunchRequestSchema), async (c) => {
    const { initData } = c.req.valid('json');
    const parsed = validateInitData(initData, ctx.config.BOT_TOKEN);
    if (parsed.user.is_bot) throw new DomainError('unauthorized', 'bots cannot launch the app');
    let user = await ensureUser(ctx.deps.db, {
      telegramUserId: parsed.user.id,
      firstName: parsed.user.first_name,
      username: parsed.user.username ?? null,
      languageCode: parsed.user.language_code ?? null,
    });
    if (parsed.user.allows_write_to_pm === true && !user.dmAllowed) {
      await setDmAllowed(ctx.deps.db, user.id, true);
      user = { ...user, dmAllowed: true };
    }
    const token = await issueSessionToken(ctx.config.SESSION_SECRET, user.id);
    const route = await resolveLaunchRoute(ctx, user, decodeStartParam(parsed.startParam));
    // A home launch already carries every active game, so the badge is a filter rather than a
    // second query; every other launch pays for the count it cannot derive.
    const yourMove =
      route.kind === 'home'
        ? route.games.items.filter((game) => game.yourTurn).length
        : await yourMoveTotal(ctx.deps, user.id);
    const response: LaunchResponse = {
      token,
      user: { id: String(user.id), name: displayName(user), username: user.username },
      prefs: prefsOf(user),
      askWriteAccess: user.writeAccessAskedAt === null && !user.dmAllowed,
      yourMove,
      route,
      serverTime: (await dbNow(ctx.deps.db)).toISOString(),
      bot: { username: ctx.config.BOT_USERNAME, miniAppShortName: ctx.config.MINI_APP_SHORT_NAME },
    };
    return c.json(response);
  });
  return app;
}
