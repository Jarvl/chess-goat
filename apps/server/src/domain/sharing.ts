import { and, eq, sql } from 'drizzle-orm';
import { shares } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGameByPublicId } from './games';
import { enqueue } from '../jobs/queue';

/**
 * Enough for a user to share a run of positions at once, while one user still cannot
 * post more than a minute's worth of the group's ~20 messages per minute.
 */
export const MAX_SHARES_PER_MINUTE = 20;

/** shared positions are limited per user per minute; the photo itself is a job. */
export async function sharePosition(
  deps: Deps,
  input: { gameId: string; userId: number; ply: number },
): Promise<{ shareId: number }> {
  return deps.db.transaction(async (tx) => {
    const game = await requireGameByPublicId(tx, input.gameId);
    if (input.ply > game.plyCount)
      throw new DomainError('validation', 'ply is beyond the game', { plyCount: game.plyCount });
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shares)
      .where(
        and(
          eq(shares.userId, input.userId),
          sql`${shares.createdAt} > now() - interval '1 minute'`,
        ),
      );
    if ((recent?.n ?? 0) >= MAX_SHARES_PER_MINUTE)
      throw new DomainError('rate_limited', 'too many shared positions this minute', {
        reason: 'share',
      });
    const [share] = await tx
      .insert(shares)
      .values({ gameId: game.id, userId: input.userId, ply: input.ply })
      .returning({ id: shares.id });
    if (!share) throw new Error('share insert returned no row');
    await enqueue(tx, { kind: 'send_share_photo', payload: { shareId: share.id } });
    return { shareId: share.id };
  });
}
