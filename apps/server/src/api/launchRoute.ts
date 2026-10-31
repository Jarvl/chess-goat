import type { LaunchRoute, StartParam } from '@chess-goat/shared';
import type { UserRow } from '../db/schema';
import { groupSettingsDto } from '../domain/admin';
import { colourOf } from '../domain/gameDto';
import { loadGameDto, requireGameByPublicId } from '../domain/games';
import { requireGroup, requireGroupByPublicId } from '../domain/groups';
import { buildLobby, meGames } from '../domain/lobby';
import type { ApiContext } from './context';

/** Spec §5.3/§6.1: where a launch lands, with that screen's data; no membership evidence means locked. */
export async function resolveLaunchRoute(
  ctx: ApiContext,
  user: UserRow,
  param: StartParam | null,
): Promise<LaunchRoute> {
  const { db } = ctx.deps;
  if (!param) return { kind: 'home', games: await meGames(ctx.deps, user.id) };
  if (param.kind === 'game') {
    const game = await requireGameByPublicId(db, param.gameId);
    const group = await requireGroup(db, game.groupId);
    if (!colourOf(game, user.id) && !(await ctx.membership.verify(group, user))) {
      return { kind: 'locked', group: { id: group.publicId, title: group.title } };
    }
    const dto = await loadGameDto(db, game, user.id);
    ctx.metrics.gameOpens.inc({ role: dto.viewerRole });
    return { kind: 'game', game: dto };
  }
  const group = await requireGroupByPublicId(db, param.groupId);
  if (!(await ctx.membership.verify(group, user)))
    return { kind: 'locked', group: { id: group.publicId, title: group.title } };
  const isAdmin = await ctx.membership.isAdmin(group, user);
  if (param.kind === 'settings' && isAdmin)
    return { kind: 'settings', settings: await groupSettingsDto(db, group) };
  const lobby = await buildLobby(ctx.deps, group, user, { isAdmin });
  // New game lands on top of the lobby, so its data comes along for the BackButton.
  return param.kind === 'newGame' ? { kind: 'newGame', lobby } : { kind: 'lobby', lobby };
}
