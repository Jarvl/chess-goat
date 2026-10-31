import { BlockRequestSchema, GroupSettingsUpdateRequestSchema } from '@chess-goat/shared';
import type { Context, Hono } from 'hono';
import {
  adminBlock,
  adminUnblock,
  adminUpdateSettings,
  groupSettingsDto,
} from '../../domain/admin';
import { requireGameByPublicId, voidGame } from '../../domain/games';
import { requireGroup, requireGroupByPublicId } from '../../domain/groups';
import { requireAdmin } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam, userIdParam } from '../middleware';
import { validate } from '../validate';

/** Spec §7.11/§12: every read and write re-checks admin rights through the cached ladder. */
export function adminRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  type Ctx = Context<ApiEnv>;
  const adminGroup = async (c: Ctx) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    await requireAdmin(ctx, group, c.get('user'));
    return group;
  };

  api.get('/groups/:g/settings', async (c) =>
    c.json(await groupSettingsDto(db, await adminGroup(c))),
  );

  api.put('/groups/:g/settings', validate('json', GroupSettingsUpdateRequestSchema), async (c) => {
    const group = await adminGroup(c);
    return c.json(
      await adminUpdateSettings(ctx.deps, group, c.get('user').id, c.req.valid('json')),
    );
  });

  api.post('/groups/:g/blocks', validate('json', BlockRequestSchema), async (c) => {
    const group = await adminGroup(c);
    await adminBlock(ctx.deps, group, c.get('user').id, Number(c.req.valid('json').userId));
    return c.json({ ok: true });
  });

  api.delete('/groups/:g/blocks/:u', async (c) => {
    const group = await adminGroup(c);
    await adminUnblock(ctx.deps, group, c.get('user').id, userIdParam(c, 'u'));
    return c.json({ ok: true });
  });

  api.post('/games/:id/void', async (c) => {
    const game = await requireGameByPublicId(db, publicIdParam(c, 'id'));
    const group = await requireGroup(db, game.groupId);
    await requireAdmin(ctx, group, c.get('user'));
    return c.json(
      await voidGame(ctx.deps, { gameId: game.publicId, adminUserId: c.get('user').id }),
    );
  });
}
