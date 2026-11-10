import { ColourChoiceSchema, sideToMove, type ColourChoice } from '@chess-goat/shared';
import { and, asc, eq, gt, inArray, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import { challenges, games, groups, users, type UserRow } from '../db/schema';
import { z } from 'zod';
import { BotViewPersonSchema, DrawOfferSchema, drawOfferFor } from './botView';
import { displayName } from './users';
import { kindOf } from './playerKind';

const InboxBotSchema = z.object({ id: z.number().int(), name: z.string() });

/**
 * What one of an owner's bots has to act on. The schema is the
 * source of truth for get_inbox's output and for the type.
 */
export const InboxEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('challenge'),
    bot: InboxBotSchema,
    challengeId: z.string(),
    from: BotViewPersonSchema,
    group: z.object({ groupId: z.string(), title: z.string() }),
    timePerMove: z.number().nullable(),
    rated: z.boolean(),
    /** The colour the bot would play. */
    colour: ColourChoiceSchema,
    expiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('your_move'),
    bot: InboxBotSchema,
    gameId: z.string(),
    opponent: BotViewPersonSchema,
    ply: z.number().int(),
    deadlineAt: z.string().nullable(),
    drawOffer: DrawOfferSchema,
    /** The bot's premove reply to `opponentMove` (both UCI) was illegal, so its tree was dropped. */
    premoveFailed: z.object({ opponentMove: z.string(), reply: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal('draw_offer'),
    bot: InboxBotSchema,
    gameId: z.string(),
    opponent: BotViewPersonSchema,
    ply: z.number().int(),
  }),
]);

export type InboxEntry = z.infer<typeof InboxEntrySchema>;
type InboxBot = z.infer<typeof InboxBotSchema>;
type InboxPerson = z.infer<typeof BotViewPersonSchema>;

type Sorted = { entry: InboxEntry; deadline: number | null; since: number };

/** At most this many entries per read; `more` says there are others. */
export const INBOX_PAGE = 50;

export type Inbox = { entries: InboxEntry[]; more: boolean };

/** The user columns an entry needs: a name, and whether it is a bot. */
type PersonKey =
  'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'ownerId' | 'ownerName';
type Person = Pick<UserRow, PersonKey>;

function personColumns<U extends Record<PersonKey, AnyColumn>>(user: U): Pick<U, PersonKey> {
  return {
    id: user.id,
    firstName: user.firstName,
    username: user.username,
    deletedAt: user.deletedAt,
    isEngine: user.isEngine,
    ownerId: user.ownerId,
    ownerName: user.ownerName,
  };
}

const botOf = (row: Person): InboxBot => ({ id: row.id, name: row.firstName });
const personOf = (row: Person): InboxPerson => ({
  name: displayName(row),
  kind: kindOf(row),
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
 * draw offers made to them on the opponent's turn. Soonest deadline first, at most `INBOX_PAGE`
 * entries; `more` when there are others. One query per kind, whatever the number of bots.
 */
export async function loadInbox(tx: DbOrTx, botIds: readonly number[]): Promise<Inbox> {
  if (botIds.length === 0) return { entries: [], more: false };
  const ids = [...botIds];
  const bot = alias(users, 'bot');
  const challenger = alias(users, 'challenger');
  const white = alias(users, 'white');
  const black = alias(users, 'black');
  const side = sql`split_part(${games.fen}, ' ', 2)`;
  // The game needs one of the bots: on its move, or answering a draw offer on the opponent's.
  const whiteActs = and(
    inArray(games.whiteId, ids),
    or(sql`${side} = 'w'`, eq(games.drawOfferBy, 'black')),
  );
  const blackActs = and(
    inArray(games.blackId, ids),
    or(sql`${side} = 'b'`, eq(games.drawOfferBy, 'white')),
  );
  // As `byUrgency` sorts: a deadline counts only while a bot's own clock runs.
  const botToMove = sql`((${side} = 'w' and ${inArray(games.whiteId, ids)}) or (${side} = 'b' and ${inArray(games.blackId, ids)}))`;

  const [challengeRows, gameRows] = await Promise.all([
    tx
      .select({
        challenge: {
          publicId: challenges.publicId,
          timePerMove: challenges.timePerMove,
          rated: challenges.rated,
          challengerColour: challenges.challengerColour,
          expiresAt: challenges.expiresAt,
          createdAt: challenges.createdAt,
        },
        group: { publicId: groups.publicId, title: groups.title },
        bot: personColumns(bot),
        challenger: personColumns(challenger),
      })
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
      )
      .orderBy(asc(challenges.expiresAt), asc(challenges.createdAt), asc(challenges.id))
      .limit(INBOX_PAGE + 1),
    tx
      .select({
        game: {
          publicId: games.publicId,
          fen: games.fen,
          plyCount: games.plyCount,
          deadlineAt: games.deadlineAt,
          drawOfferBy: games.drawOfferBy,
          premoveFailure: games.premoveFailure,
          lastMoveAt: games.lastMoveAt,
          startedAt: games.startedAt,
        },
        white: personColumns(white),
        black: personColumns(black),
      })
      .from(games)
      .innerJoin(white, eq(white.id, games.whiteId))
      .innerJoin(black, eq(black.id, games.blackId))
      .where(and(eq(games.status, 'active'), or(whiteActs, blackActs)))
      .orderBy(
        sql`case when ${botToMove} then ${games.deadlineAt} end asc nulls last`,
        sql`coalesce(${games.lastMoveAt}, ${games.startedAt}) asc`,
        asc(games.id),
      )
      .limit(INBOX_PAGE + 1),
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
    const toMove = sideToMove(game.fen);
    const since = (game.lastMoveAt ?? game.startedAt).getTime();
    const sides = [
      { colour: 'white' as const, me: white, opponent: black },
      { colour: 'black' as const, me: black, opponent: white },
    ];
    for (const { colour, me, opponent } of sides) {
      if (!ids.includes(me.id)) continue;
      if (toMove === colour) {
        const failure = game.premoveFailure;
        const failed = failure?.botId === me.id && failure.ply === game.plyCount;
        sorted.push({
          entry: {
            kind: 'your_move',
            bot: botOf(me),
            gameId: game.publicId,
            opponent: personOf(opponent),
            ply: game.plyCount,
            deadlineAt: game.deadlineAt?.toISOString() ?? null,
            drawOffer: drawOfferFor(game.drawOfferBy, colour),
            ...(failed
              ? { premoveFailed: { opponentMove: failure.opponentMove, reply: failure.reply } }
              : {}),
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
  const more =
    challengeRows.length > INBOX_PAGE || gameRows.length > INBOX_PAGE || sorted.length > INBOX_PAGE;
  return {
    entries: sorted
      .sort(byUrgency)
      .slice(0, INBOX_PAGE)
      .map(({ entry }) => entry),
    more,
  };
}
