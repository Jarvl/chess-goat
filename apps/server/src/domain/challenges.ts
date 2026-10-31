import { randomInt } from 'node:crypto';
import { INITIAL_FEN, opposite, type ColourChoice, type TimePerMove } from '@chess-goat/shared';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { generatePublicId } from '../db/ids';
import { challenges, games, type ChallengeRow, type GameRow, type UserRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGroup, settingsOf } from './groups';
import {
  MAX_PENDING_CHALLENGES,
  countPendingChallenges,
  deadlineExpression,
  reminderExpression,
} from './limits';
import { isBlocked } from './members';
import { challengeStub, type ChallengeOutcome } from './dmText';
import { retireChallengeDms } from './dms';
import { nameWithFlair, requireUser, wantsDms } from './users';

export type CreateChallengeInput = {
  groupId: number;
  challengerId: number;
  /** null for an open challenge. */
  opponentId: number | null;
  /** A Telegram username (any case, optional `@`) for an opponent the bot has not seen; null otherwise. */
  opponentUsername: string | null;
  timePerMove: TimePerMove;
  colour: ColourChoice;
  rated: boolean;
  /** Forum topic the card belongs to; null for the General topic or a basic group. */
  threadId: number | null;
};

export function randomColour(): 'white' | 'black' {
  return randomInt(2) === 0 ? 'white' : 'black';
}

/**
 * There is no cap on how many games someone may have going, or on how many with one opponent — a
 * player decides what they can keep up with. Being blocked in the group is the only thing that stops
 * a game starting.
 */
async function assertNotBlocked(tx: DbOrTx, groupId: number, user: UserRow): Promise<void> {
  if (await isBlocked(tx, groupId, user.id)) {
    throw new DomainError('forbidden', 'blocked in this group', {
      reason: 'blocked',
      userId: user.id,
    });
  }
}

export async function getChallengeById(tx: DbOrTx, id: number): Promise<ChallengeRow | null> {
  const [row] = await tx.select().from(challenges).where(eq(challenges.id, id)).limit(1);
  return row ?? null;
}

export async function getChallengeByPublicId(
  tx: DbOrTx,
  publicId: string,
): Promise<ChallengeRow | null> {
  const [row] = await tx
    .select()
    .from(challenges)
    .where(eq(challenges.publicId, publicId))
    .limit(1);
  return row ?? null;
}

/**
 * Records the card's message id. A game accepted before the card was sent has no message id yet,
 * so the first id also becomes that game's card (later edits must be able to find it).
 */
export async function setChallengeMessage(
  tx: DbOrTx,
  challengeId: number,
  messageId: number,
): Promise<void> {
  const [challenge] = await tx
    .update(challenges)
    .set({ messageId })
    .where(eq(challenges.id, challengeId))
    .returning({ gameId: challenges.gameId });
  if (challenge?.gameId != null) {
    await tx
      .update(games)
      .set({ cardMessageId: messageId })
      .where(and(eq(games.id, challenge.gameId), isNull(games.cardMessageId)));
  }
}

function editCard(tx: DbOrTx, challenge: Pick<ChallengeRow, 'id' | 'publicId'>): Promise<void> {
  return enqueue(tx, {
    kind: 'edit_card',
    payload: { challengeId: challenge.id },
    dedupKey: `card:ch:${challenge.publicId}`,
  });
}

/** DM notifications spec §2.4: once a challenge is settled, the challenged player's DM about it goes. */
export async function retireChallengeDm(
  tx: DbOrTx,
  challenge: Pick<ChallengeRow, 'id' | 'challengerId'>,
  outcome: ChallengeOutcome,
): Promise<void> {
  const challenger = await requireUser(tx, challenge.challengerId);
  await retireChallengeDms(tx, challenge.id, challengeStub(nameWithFlair(challenger), outcome));
}

/** Spec §7.1/§7.8: limits checked, the card send and the opponent's DM enqueued in the same transaction. */
export async function createChallenge(
  deps: Deps,
  input: CreateChallengeInput,
): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const group = await requireGroup(tx, input.groupId);
    const settings = settingsOf(group);
    const opponentUsername = input.opponentUsername?.replace(/^@/, '').toLowerCase() || null;
    if (input.opponentId !== null && opponentUsername !== null) {
      throw new DomainError('validation', 'name the opponent by id or by username, not both', {
        reason: 'opponent_ambiguous',
      });
    }
    if (input.opponentId !== null && input.opponentId === input.challengerId) {
      throw new DomainError('validation', 'cannot challenge yourself', { reason: 'self' });
    }
    if (input.opponentId === null && opponentUsername === null && !settings.allowOpenChallenges) {
      throw new DomainError('forbidden', 'open challenges are off in this group', {
        reason: 'open_disabled',
      });
    }
    const challenger = await requireUser(tx, input.challengerId);
    if (opponentUsername !== null && opponentUsername === challenger.username?.toLowerCase()) {
      throw new DomainError('validation', 'cannot challenge yourself', { reason: 'self' });
    }
    await assertNotBlocked(tx, group.id, challenger);
    const pending = await countPendingChallenges(tx, group.id, challenger.id);
    if (pending >= MAX_PENDING_CHALLENGES) {
      throw new DomainError('limit_exceeded', 'too many pending challenges', {
        reason: 'pending_limit',
        count: pending,
      });
    }
    let opponent: UserRow | null = null;
    if (input.opponentId !== null) {
      opponent = await requireUser(tx, input.opponentId);
      if (opponent.deletedAt) {
        throw new DomainError('not_found', 'opponent no longer plays here', {
          reason: 'opponent_gone',
        });
      }
      await assertNotBlocked(tx, group.id, opponent);
    }
    const [challenge] = await tx
      .insert(challenges)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        challengerId: challenger.id,
        opponentId: opponent?.id ?? null,
        opponentUsername,
        timePerMove: input.timePerMove,
        challengerColour: input.colour,
        rated: input.rated,
        threadId: input.threadId,
        expiresAt: sql`now() + interval '24 hours'`,
      })
      .returning();
    if (!challenge) throw new Error('challenge insert returned no row');
    await enqueue(tx, {
      kind: 'send_challenge_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:send:${challenge.publicId}`,
    });
    if (opponent) {
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId: opponent.id, template: 'challenge', challengeId: challenge.id },
        dedupKey: `dm:${opponent.id}:ch:${challenge.publicId}`,
      });
    }
    return challenge;
  });
}

async function lockPendingChallenge(tx: DbOrTx, challengeId: number): Promise<ChallengeRow> {
  const [challenge] = await tx
    .select()
    .from(challenges)
    .where(eq(challenges.id, challengeId))
    .limit(1)
    .for('update');
  if (!challenge) throw new DomainError('not_found', 'challenge not found');
  if (challenge.status === 'accepted') {
    throw new DomainError('stale_state', 'someone accepted first', { reason: 'accepted_first' });
  }
  if (challenge.status !== 'pending') {
    throw new DomainError('expired', 'this challenge is no longer open', {
      reason: 'challenge_gone',
    });
  }
  const now = await dbNow(tx);
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    throw new DomainError('expired', 'this challenge has expired', { reason: 'challenge_gone' });
  }
  return challenge;
}

/** Only the named opponent — by id, or by the username on their stored profile — may answer. */
function assertIsOpponent(
  challenge: ChallengeRow,
  user: UserRow,
  verb: 'accept' | 'decline',
): void {
  if (challenge.opponentUsername !== null) {
    if (user.username?.toLowerCase() === challenge.opponentUsername) return;
    throw new DomainError('forbidden', `only the challenged player can ${verb}`, {
      reason: 'not_your_challenge',
      opponentUsername: challenge.opponentUsername,
    });
  }
  if (challenge.opponentId !== null && challenge.opponentId !== user.id) {
    throw new DomainError('forbidden', `only the challenged player can ${verb}`, {
      reason: 'not_your_challenge',
      opponentId: challenge.opponentId,
    });
  }
}

/** Spec §7.1 accept: the row lock makes the first committed acceptance of an open challenge win. */
export async function acceptChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<{ challenge: ChallengeRow; game: GameRow }> {
  const result = await deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    const accepter = await requireUser(tx, input.userId);
    assertIsOpponent(challenge, accepter, 'accept');
    if (challenge.challengerId === input.userId) {
      throw new DomainError('forbidden', 'cannot accept your own challenge', {
        reason: 'own_challenge',
      });
    }
    const group = await requireGroup(tx, challenge.groupId);
    const challenger = await requireUser(tx, challenge.challengerId);
    await assertNotBlocked(tx, group.id, accepter);
    await assertNotBlocked(tx, group.id, challenger);

    const challengerColour =
      challenge.challengerColour === 'random' ? randomColour() : challenge.challengerColour;
    const white = challengerColour === 'white' ? challenger : accepter;
    const black = challengerColour === 'white' ? accepter : challenger;
    const timePerMove = challenge.timePerMove as TimePerMove;
    const [game] = await tx
      .insert(games)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        whiteId: white.id,
        blackId: black.id,
        timePerMove,
        rated: challenge.rated,
        fen: INITIAL_FEN,
        deadlineAt: deadlineExpression(timePerMove),
        reminderAt: reminderExpression(timePerMove, wantsDms(white)),
        cardMessageId: challenge.messageId,
        cardThreadId: challenge.threadId,
      })
      .returning();
    if (!game) throw new Error('game insert returned no row');
    const [accepted] = await tx
      .update(challenges)
      .set({
        status: 'accepted',
        opponentId: accepter.id,
        opponentUsername: null,
        gameId: game.id,
        resolvedAt: sql`now()`,
      })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await retireChallengeDm(tx, challenge, 'accepted');
    await enqueue(tx, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId: white.id, template: 'turn', gameId: game.id },
      dedupKey: `dm:${white.id}:g:${game.publicId}`,
      mergePayload: true,
    });
    return { challenge: accepted ?? challenge, game };
  });
  deps.bus.publish(result.game.publicId);
  return result;
}

export async function declineChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    // An open challenge has nobody to decline it: the same button withdraws it, for the challenger.
    if (challenge.opponentId === null && challenge.opponentUsername === null) {
      throw new DomainError('forbidden', 'only the challenger can withdraw an open challenge', {
        reason: 'not_the_challenger',
        challengerId: challenge.challengerId,
      });
    }
    assertIsOpponent(challenge, await requireUser(tx, input.userId), 'decline');
    const [declined] = await tx
      .update(challenges)
      .set({ status: 'declined', resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await editCard(tx, challenge);
    await retireChallengeDm(tx, challenge, 'declined');
    return declined ?? challenge;
  });
}

export async function cancelChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    if (challenge.challengerId !== input.userId) {
      throw new DomainError('forbidden', 'only the challenger can withdraw', {
        reason: 'not_the_challenger',
        challengerId: challenge.challengerId,
      });
    }
    const [cancelled] = await tx
      .update(challenges)
      .set({ status: 'cancelled', resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await editCard(tx, challenge);
    await retireChallengeDm(tx, challenge, 'cancelled');
    return cancelled ?? challenge;
  });
}

/** Scanner (spec §7.3): pending challenges past `expires_at`, at most `limit` per pass. */
export async function expireChallenges(deps: Deps, limit = 100): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: challenges.id,
        publicId: challenges.publicId,
        challengerId: challenges.challengerId,
      })
      .from(challenges)
      .where(and(eq(challenges.status, 'pending'), lte(challenges.expiresAt, sql`now()`)))
      .orderBy(asc(challenges.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const challenge of due) {
      await tx
        .update(challenges)
        .set({ status: 'expired', resolvedAt: sql`now()` })
        .where(and(eq(challenges.id, challenge.id), eq(challenges.status, 'pending')));
      await editCard(tx, challenge);
      await retireChallengeDm(tx, challenge, 'expired');
    }
    return due.length;
  });
}

/** PRD §7.2: a reversed-colour challenge with the same terms, as a new card. */
export async function createRematch(
  deps: Deps,
  input: { gameId: number; userId: number },
): Promise<ChallengeRow> {
  const [game] = await deps.db.select().from(games).where(eq(games.id, input.gameId)).limit(1);
  if (!game) throw new DomainError('not_found', 'game not found');
  if (game.status !== 'finished') throw new DomainError('stale_state', 'the game is still running');
  // Spec §8: a bot rematch is a new engine game, created by the app through POST
  // /groups/:g/engine-games. Going through a challenge would post a card to the group and wait for
  // an acceptance that never comes.
  if (game.engineLevel !== null) {
    throw new DomainError('validation', 'use a new bot game for a rematch', {
      reason: 'engine_game',
    });
  }
  const colour =
    game.whiteId === input.userId ? 'white' : game.blackId === input.userId ? 'black' : null;
  if (!colour) throw new DomainError('forbidden', 'only the players can ask for a rematch');
  return createChallenge(deps, {
    groupId: game.groupId,
    challengerId: input.userId,
    opponentId: colour === 'white' ? game.blackId : game.whiteId,
    opponentUsername: null,
    timePerMove: game.timePerMove as TimePerMove,
    colour: opposite(colour),
    rated: game.rated,
    threadId: game.cardThreadId,
  });
}
