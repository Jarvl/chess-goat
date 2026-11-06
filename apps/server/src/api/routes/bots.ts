import { BotListQuerySchema, type BotListDto } from '@chess-goat/shared';
import type { Hono } from 'hono';
import { decodeBotCursor, encodeBotCursor, searchGroupBots } from '../../domain/botGroups';
import { requireGroupByPublicId } from '../../domain/groups';
import { toPlayerRef } from '../../domain/players';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

const PAGE_SIZE = 20;

export function botsRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;

  /** The group's bot browser: the bots `find_bots` shows, searched, sorted and paged. */
  api.get('/groups/:g/bots', validate('query', BotListQuerySchema), async (c) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    await requireMember(ctx, group, c.get('user'));
    const { q, sort = 'rating', cursor } = c.req.valid('query');
    const page = await searchGroupBots(db, group.id, {
      query: q,
      sort,
      limit: PAGE_SIZE,
      cursor: cursor ? decodeBotCursor(sort, cursor) : undefined,
    });
    const body: BotListDto = {
      bots: page.rows.map(({ bot, stats }) => ({
        ...toPlayerRef(bot, stats),
        tagline: bot.tagline,
        owner: bot.ownerName ?? 'Unknown',
        gamesPlayed: stats?.gamesPlayed ?? 0,
        record: { wins: stats?.wins ?? 0, draws: stats?.draws ?? 0, losses: stats?.losses ?? 0 },
      })),
      nextCursor: page.next ? encodeBotCursor(sort, page.next.key, page.next.id) : null,
    };
    return c.json(body);
  });
}
