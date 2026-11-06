import type { Colour, ColourChoice } from '@chess-goat/shared';
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import { challenges, games, groups, users, type UserRow } from '../db/schema';
import { displayName, isOwnedBot } from './users';

export type InboxBot = { id: number; name: string };
export type InboxPerson = { name: string; isBot: boolean };

/** What one of an owner's bots has to act on (bots spec §7; MCP plan, Task 5). */
export type InboxEntry =
  | {
      kind: 'challenge';
      bot: InboxBot;
      challengeId: string;
      from: InboxPerson;
      group: { groupId: string; title: string };
      timePerMove: number | null;
      rated: boolean;
      /** The colour the bot would play. */
      colour: ColourChoice;
      expiresAt: string;
    }
  | {
      kind: 'your_move';
      bot: InboxBot;
      gameId: string;
      opponent: InboxPerson;
      ply: number;
      deadlineAt: string | null;
      drawOffer: 'none' | 'from_you' | 'from_opponent';
    }
  | { kind: 'draw_offer'; bot: InboxBot; gameId: string; opponent: InboxPerson; ply: number };

type Sorted = { entry: InboxEntry; deadline: number | null; since: number };

const botOf = (row: UserRow): InboxBot => ({ id: row.id, name: row.firstName });
const personOf = (row: UserRow): InboxPerson => ({
  name: displayName(row),
  isBot: isOwnedBot(row),
});
const opposite = (colour: ColourChoice): ColourChoice =>
  colour === 'white' ? 'black' : colour === 'black' ? 'white' : 'random';

/** Soonest deadline first, none last; then oldest first. */
function byUrgency(a: Sorted, b: Sorted): number {
  if (a.deadline !== b.deadline) {
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline - b.deadline;
  }
  return a.since - b.since;
}

/**
 * The inbox of `botIds`: pending challenges sent to them, active games where one is to move, and
 * draw offers made to them on the opponent's turn. One query per kind, whatever the number of bots.
 */
export async function loadInbox(tx: DbOrTx, botIds: readonly number[]): Promise<InboxEntry[]> {
  if (botIds.length === 0) return [];
  const ids = [...botIds];
  const bot = alias(users, 'bot');
  const challenger = alias(users, 'challenger');
  const white = alias(users, 'white');
  const black = alias(users, 'black');

  const [challengeRows, gameRows] = await Promise.all([
    tx
      .select({ challenge: challenges, group: groups, bot, challenger })
      .from(challenges)
      .innerJoin(groups, eq(groups.id, challenges.groupId))
      .innerJoin(bot, eq(bot.id, challenges.opponentId))
      .innerJoin(challenger, eq(challenger.id, challenges.challengerId))
      .where(
        and(
          eq(challenges.status, 'pending'),
          inArray(challenges.opponentId, ids),
          gt(challenges.expiresAt, sql`now()`),
        ),
      ),
    tx
      .select({ game: games, white, black })
      .from(games)
      .innerJoin(white, eq(white.id, games.whiteId))
      .innerJoin(black, eq(black.id, games.blackId))
      .where(
        and(
          eq(games.status, 'active'),
          or(inArray(games.whiteId, ids), inArray(games.blackId, ids)),
        ),
      ),
  ]);

  const sorted: Sorted[] = challengeRows.map(({ challenge, group, bot, challenger }) => ({
    entry: {
      kind: 'challenge',
      bot: botOf(bot),
      challengeId: challenge.publicId,
      from: personOf(challenger),
      group: { groupId: group.publicId, title: group.title },
      timePerMove: challenge.timePerMove,
      rated: challenge.rated,
      colour: opposite(challenge.challengerColour),
      expiresAt: challenge.expiresAt.toISOString(),
    },
    deadline: challenge.expiresAt.getTime(),
    since: challenge.createdAt.getTime(),
  }));

  for (const { game, white, black } of gameRows) {
    const toMove: Colour = game.plyCount % 2 === 0 ? 'white' : 'black';
    const since = (game.lastMoveAt ?? game.startedAt).getTime();
    const sides = [
      { colour: 'white' as const, me: white, opponent: black },
      { colour: 'black' as const, me: black, opponent: white },
    ];
    for (const { colour, me, opponent } of sides) {
      if (!ids.includes(me.id)) continue;
      if (toMove === colour) {
        sorted.push({
          entry: {
            kind: 'your_move',
            bot: botOf(me),
            gameId: game.publicId,
            opponent: personOf(opponent),
            ply: game.plyCount,
            deadlineAt: game.deadlineAt?.toISOString() ?? null,
            drawOffer:
              game.drawOfferBy === null
                ? 'none'
                : game.drawOfferBy === colour
                  ? 'from_you'
                  : 'from_opponent',
          },
          deadline: game.deadlineAt?.getTime() ?? null,
          since,
        });
      } else if (game.drawOfferBy !== null && game.drawOfferBy !== colour) {
        // The bot's own clock isn't running, so the offer has no deadline for it.
        sorted.push({
          entry: {
            kind: 'draw_offer',
            bot: botOf(me),
            gameId: game.publicId,
            opponent: personOf(opponent),
            ply: game.plyCount,
          },
          deadline: null,
          since,
        });
      }
    }
  }
  return sorted.sort(byUrgency).map(({ entry }) => entry);
}
