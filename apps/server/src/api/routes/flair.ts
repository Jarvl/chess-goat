import { FlairUpdateRequestSchema, type FlairDto } from '@chess-goat/shared';
import type { Hono } from 'hono';
import { loadFlairDto, setWornFlair } from '../../flair/profile';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

/** Flair spec §4: the caller's own flair, read and chosen. Both routes sit behind the session. */
export function flairRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  api.get('/me/flair', async (c) => {
    const body: FlairDto = await loadFlairDto(ctx.deps.db, c.get('user').id);
    return c.json(body);
  });

  api.put('/me/flair', validate('json', FlairUpdateRequestSchema), async (c) => {
    const { worn } = c.req.valid('json');
    const userId = c.get('user').id;
    const body: FlairDto = await ctx.deps.db.transaction((tx) => setWornFlair(tx, userId, worn));
    return c.json(body);
  });
}
