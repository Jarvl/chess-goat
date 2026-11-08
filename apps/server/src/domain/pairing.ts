import type { TimePerMove } from '@chess-goat/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client';
import { groupMembers, users, type UserRow } from '../db/schema';
import { DomainError } from './errors';
import { MAX_LIVE_GAMES_PER_BOT, countLiveGames } from './limits';
import { getMember, isBlocked } from './members';
import { displayName, isOwnedBot } from './users';

/**
 * Pairing: whether two players may meet in a group, and on what terms. The one place these rules
 * live. `mayPlay` checks one player; `checkPairing` checks a pair. `findableIn` is the same
 * one-player rule for bots, as SQL, for listing them; a shared test table holds the two forms
 * together.
 */

/**
 * What a Pairing error says about the player it is about, so a reader can tell "your bot" from
 * "your opponent": `subjectId`, `subjectOwnerId` (null for a person) and their display `name`.
 */
const about = (player: UserRow) => ({
  subjectId: player.id,
  subjectOwnerId: player.ownerId,
  name: displayName(player),
});

const forbidden = (
  reason: 'owner_not_member' | 'blocked' | 'bot_not_in_group',
  message: string,
  player: UserRow,
) => new DomainError('forbidden', message, { reason, ...about(player) });

/**
 * Whether `player` may play in the group. Anyone: not deleted, not blocked (blocking an owner
 * blocks their bots). A bot also: a member here, and its owner a member here. A person need not be
 * a known member: a challenge by username names someone the bot has not seen.
 */
export async function mayPlay(tx: DbOrTx, groupId: number, player: UserRow): Promise<void> {
  if (player.deletedAt) {
    throw new DomainError('not_found', 'opponent no longer plays here', {
      reason: 'opponent_gone',
      ...about(player),
    });
  }
  if (await isBlocked(tx, groupId, player.id)) {
    throw forbidden('blocked', 'blocked in this group', player);
  }
  if (!isOwnedBot(player)) return;
  const member = await getMember(tx, groupId, player.id);
  if (member?.status !== 'member') {
    throw forbidden('bot_not_in_group', 'this bot is not in the group', player);
  }
  const owner = await getMember(tx, groupId, player.ownerId!);
  if (owner?.status !== 'member') {
    throw forbidden('owner_not_member', "the bot's owner is not in the group", player);
  }
}

export type Pair = {
  challenger: UserRow;
  /** null when the challenge names no one by id: open, or by a username not yet seen. */
  opponent: UserRow | null;
  /** The challenge is open to anyone (it named no one at all). */
  open: boolean;
};

export type PairingTerms = { timePerMove: TimePerMove; rated: boolean };

/**
 * Checks that the pair may meet in the group on these terms, and returns what follows: how many
 * of the players are bots, and whether the game is rated. Throws the first rule broken.
 */
export async function checkPairing(
  tx: DbOrTx,
  groupId: number,
  pair: Pair,
  terms: PairingTerms,
): Promise<{ botPlayers: 0 | 1 | 2; rated: boolean }> {
  const { challenger, opponent } = pair;
  if (opponent && opponent.id === challenger.id) {
    throw new DomainError('validation', 'cannot challenge yourself', { reason: 'self' });
  }
  await mayPlay(tx, groupId, challenger);
  if (opponent) await mayPlay(tx, groupId, opponent);
  if (isOwnedBot(challenger) && (opponent === null || !isOwnedBot(opponent))) {
    throw new DomainError('forbidden', 'bots only challenge bots', {
      reason: 'bots_challenge_bots_only',
    });
  }
  // A bot answers only challenges made to it by name.
  if (opponent && isOwnedBot(opponent) && pair.open) {
    throw new DomainError('forbidden', 'bots cannot take open challenges', {
      reason: 'open_challenges_are_for_people',
    });
  }
  for (const player of [challenger, opponent]) {
    if (!player || !isOwnedBot(player)) continue;
    if ((await countLiveGames(tx, player.id)) >= MAX_LIVE_GAMES_PER_BOT) {
      throw new DomainError('limit_exceeded', 'too many live games', {
        reason: 'too_many_live_games',
        limit: MAX_LIVE_GAMES_PER_BOT,
        ...about(player),
      });
    }
  }
  const botPlayers = ((isOwnedBot(challenger) ? 1 : 0) +
    (opponent && isOwnedBot(opponent) ? 1 : 0)) as 0 | 1 | 2;
  // A game with exactly one bot runs on a time-per-move clock.
  if (botPlayers === 1 && terms.timePerMove === null) {
    throw new DomainError('validation', 'games against a bot need a time per move', {
      reason: 'bot_games_need_clock',
    });
  }
  return { botPlayers, rated: terms.rated && !sameOwner(challenger, opponent) };
}

/** An owner against their own bot, or two bots of one owner: always casual. */
function sameOwner(a: UserRow, b: UserRow | null): boolean {
  if (!b) return false;
  return (
    (a.ownerId !== null && a.ownerId === b.ownerId) || a.ownerId === b.id || b.ownerId === a.id
  );
}

/** The bot's owner's membership row, for joining beside the bot's own in `findableIn` queries. */
export const ownerMember = alias(groupMembers, 'owner_member');

export const ownerJoin = and(
  eq(ownerMember.groupId, groupMembers.groupId),
  eq(ownerMember.userId, users.ownerId),
);

/**
 * `mayPlay` for bots, as SQL over `groupMembers` joined to `users` and `ownerMember`: live owned
 * bots that are members of the group, unblocked, whose owners are unblocked members too.
 */
export function findableIn(groupId: number) {
  return [
    eq(groupMembers.groupId, groupId),
    eq(groupMembers.status, 'member'),
    isNull(groupMembers.blockedAt),
    eq(ownerMember.status, 'member'),
    isNull(ownerMember.blockedAt),
    isNull(users.deletedAt),
    sql`${users.ownerId} is not null`,
  ];
}

/** Whether `botId` is a bot that may play in the group, by `findableIn`. */
export async function isFindableBot(tx: DbOrTx, groupId: number, botId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(ownerMember, ownerJoin)
    .where(and(...findableIn(groupId), eq(users.id, botId)))
    .limit(1);
  return row !== undefined;
}
