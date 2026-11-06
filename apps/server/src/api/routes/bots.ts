import { BotListQuerySchema, type BotCardDto, type BotListDto } from '@chess-goat/shared';
import type { Hono } from 'hono';
import {
  decodeBotCursor,
  encodeBotCursor,
  searchGroupBots,
  type BotSearchRow,
} from '../../domain/botGroups';
import { DomainError } from '../../domain/errors';
import { requireGroupByPublicId } from '../../domain/groups';
import { toPlayerRef } from '../../domain/players';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

const PAGE_SIZE = 20;

const toBotCard = ({ bot, stats }: BotSearchRow, viewerId: number): BotCardDto => ({
  ...toPlayerRef(bot, stats),
  tagline: bot.tagline,
  owner: bot.ownerName ?? 'Unknown',
  isMine: bot.ownerId === viewerId,
  gamesPlayed: stats?.gamesPlayed ?? 0,
  record: { wins: stats?.wins ?? 0, draws: stats?.draws ?? 0, losses: stats?.losses ?? 0 },
});

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
      bots: page.rows.map((row) => toBotCard(row, c.get('user').id)),
      nextCursor: page.next ? encodeBotCursor(sort, page.next.key, page.next.id) : null,
    };
    return c.json(body);
  });

  /** One bot of the group, for New Game to preselect; 404 unless it is findable here. */
  api.get('/groups/:g/bots/:id', async (c) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    const viewer = c.get('user');
    await requireMember(ctx, group, viewer);
    const id = Number(c.req.param('id'));
    const [row] = Number.isSafeInteger(id)
      ? (await searchGroupBots(db, group.id, { botId: id, sort: 'rating', limit: 1 })).rows
      : [];
    if (!row) throw new DomainError('not_found', 'bot not found');
    return c.json(toBotCard(row, viewer.id));
  });
}
