import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { games } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { audienceOf } from '../../domain/gameMix';
import { rebuildGroupRatings } from '../../domain/ratings';
import { enqueue } from '../queue';
import type { JobHandler } from '../types';

const Payload = z.object({ groupId: z.number().int() });

/** Replay the group, rewrite snapshots, re-edit the cards whose displayed deltas changed. */
export function rebuildRatingsHandler(deps: Deps): JobHandler {
  return async ({ job }) => {
    const { groupId } = Payload.parse(job.payload);
    await deps.db.transaction(async (tx) => {
      const { changedGameIds } = await rebuildGroupRatings(tx, groupId);
      for (const id of changedGameIds) {
        const [game] = await tx
          .select({
            publicId: games.publicId,
            engineLevel: games.engineLevel,
            botPlayers: games.botPlayers,
          })
          .from(games)
          .where(eq(games.id, id));
        // A bot-vs-bot game has no card to edit.
        if (game && audienceOf(game).chat)
          await enqueue(tx, {
            kind: 'edit_card',
            payload: { gameId: id },
            dedupKey: `card:g:${game.publicId}`,
          });
      }
    });
  };
}
