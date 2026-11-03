import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import {
  challenges,
  games,
  groupMembers,
  userFlair,
  users,
  type ChallengeRow,
  type GameRow,
} from '../db/schema';
import type { Deps } from './deps';
import { deletedStub } from './dmText';
import { settleInChat } from './challenges';
import { retireUserDms } from './dms';
import { finishGame } from './games';
import { revokeOwnerToken } from './ownerTokens';
import { deletePhoto } from './photos';

/** The live games and pending challenges of players who are leaving, locked by `lockPlay`. */
export type Play = { leaving: ReadonlySet<number>; games: GameRow[]; challenges: ChallengeRow[] };

/**
 * Locks, `FOR UPDATE` and in id order, the active games and then the pending challenges of
 * `userIds`. Every DM writer takes the game or challenge before the user's `dm_messages` rows, and
 * the deleters take them before any `users` row, so callers must lock here first.
 */
export async function lockPlay(tx: DbOrTx, userIds: readonly number[]): Promise<Play> {
  const ids = [...new Set(userIds)];
  const activeGames = await tx
    .select()
    .from(games)
    .where(
      and(eq(games.status, 'active'), or(inArray(games.whiteId, ids), inArray(games.blackId, ids))),
    )
    .orderBy(asc(games.id))
    .for('update');
  const pending = await tx
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.status, 'pending'),
        or(inArray(challenges.challengerId, ids), inArray(challenges.opponentId, ids)),
      ),
    )
    .orderBy(asc(challenges.id))
    .for('update');
  return { leaving: new Set(ids), games: activeGames, challenges: pending };
}

/**
 * Takes the leaving players out of `play`: retires the DMs of `retireDmsOf`, resigns every live
 * game for its leaving side (white, if both sides are leaving), and cancels the challenges they
 * sent and declines the ones sent to them. Runs in the caller's transaction, after the leavers have
 * been anonymised so the stubs name them anonymously. Returns the public ids of the finished games,
 * which the caller publishes once the transaction has committed.
 */
export async function leavePlay(
  tx: DbOrTx,
  play: Play,
  now: Date,
  retireDmsOf: readonly number[],
): Promise<string[]> {
  // DM notifications spec §2.4: before the games end, so the user's own DMs all read "Game
  // ended" rather than the game-end stubs `finishGame` would give them. Each row kept its chat id.
  for (const userId of retireDmsOf) await retireUserDms(tx, userId, deletedStub());
  const publicIds: string[] = [];
  for (const game of play.games) {
    const colour = play.leaving.has(game.whiteId)
      ? 'white'
      : play.leaving.has(game.blackId)
        ? 'black'
        : null;
    if (!colour) continue;
    await finishGame(
      tx,
      game,
      { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' },
      now,
      colour,
    );
    publicIds.push(game.publicId);
  }
  for (const challenge of play.challenges) {
    const outcome = play.leaving.has(challenge.challengerId) ? 'cancelled' : 'declined';
    await tx
      .update(challenges)
      .set({ status: outcome, resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id));
    await settleInChat(tx, challenge, outcome);
  }
  return publicIds;
}

/** What a deleted bot's `users` row keeps: its id, owner and history, under the anonymous name. */
export function deletedBotFields(now: Date) {
  return { firstName: 'Deleted bot', tagline: null, deletedAt: now };
}

/** Spec §12 "Delete my data": immediate and irreversible; opponents' histories stay consistent. */
export async function deleteMyData(deps: Deps, userId: number): Promise<void> {
  const finished = await deps.db.transaction(async (tx) => {
    const now = await dbNow(tx);
    // The user's live bots go with them. Read without a lock: the games and challenges must be
    // locked before any `users` row (see `lockPlay`).
    const liveBots = and(eq(users.ownerId, userId), isNull(users.deletedAt));
    const botIds = (await tx.select({ id: users.id }).from(users).where(liveBots)).map((b) => b.id);
    // Locks in the order every DM writer takes them — the games and challenges first, then the
    // user's `dm_messages` rows — so a DM being recorded for one of these games cannot deadlock.
    let play = await lockPlay(tx, [userId, ...botIds]);
    // Anonymised before any game ends or challenge settles, so the stubs left in opponents' chats
    // name "Deleted player" rather than the handle and flair being erased.
    await tx
      .update(users)
      .set({
        telegramUserId: null,
        username: null,
        firstName: 'Deleted player',
        prefs: {},
        flairWorn: [],
        dmAllowed: false,
        writeAccessAskedAt: null,
        deletedAt: now,
      })
      .where(eq(users.id, userId));
    // The update above holds the owner's row lock, which `createBot` takes too, so no bot can be
    // created from here on. One created between the read above and that lock is caught here, and
    // its play (almost surely none yet) is locked late rather than left live.
    const deletedBots = await tx
      .update(users)
      .set(deletedBotFields(now))
      .where(liveBots)
      .returning({ id: users.id });
    if (deletedBots.some((b) => !play.leaving.has(b.id))) {
      play = await lockPlay(tx, [userId, ...botIds, ...deletedBots.map((b) => b.id)]);
    }
    const publicIds = await leavePlay(tx, play, now, [userId]);
    // Flair spec §3.4. The update above takes the row lock, which an award job for this player also
    // holds while it inserts `user_flair` rows. Deleting only after it has the lock means such a job
    // has committed and this sees its rows; a job that starts later finds `deleted_at` set (§3.2).
    await tx.delete(userFlair).where(eq(userFlair.userId, userId));
    await deletePhoto(tx, userId);
    await tx.update(groupMembers).set({ status: 'left' }).where(eq(groupMembers.userId, userId));
    await revokeOwnerToken(tx, userId);
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
}
