import type { TurnKind } from '@chess-goat/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { games, matchNotes, turnLeases, users } from '../db/schema';
import { DomainError } from './errors';

export const PERSONA_MAX = 4000;
export const BOT_NOTES_MAX = 4000;
export const MATCH_NOTES_MAX = 2000;

/** Length in Unicode code points, the unit every limit here counts. */
export const textLength = (text: string): number => [...text].length;

/** Trimmed persona, or null when empty. */
export function validPersona(raw: string | null | undefined): string | null {
  const persona = (raw ?? '').trim();
  if (persona === '') return null;
  const over = textLength(persona) - PERSONA_MAX;
  if (over > 0) {
    throw new DomainError('validation', 'persona too long', {
      reason: 'persona_too_long',
      over,
      limit: PERSONA_MAX,
    });
  }
  return persona;
}

function checkNotesLength(text: string, limit: number): void {
  const over = textLength(text) - limit;
  if (over > 0) {
    throw new DomainError('validation', 'notes too long', {
      reason: 'notes_too_long',
      over,
      limit,
    });
  }
}

/**
 * Replaces the bot's notes. Refused with `notes_changed` (carrying the current text) when another
 * lease wrote since this lease last saw them; that refusal marks the lease as caught up, so the
 * retry goes through. It runs its own transactions so the marker commits though the call throws:
 * never call it inside a caller's transaction.
 */
export async function setBotNotes(
  db: Db,
  input: { botId: number; leaseId: number; text: string },
): Promise<{ revision: number }> {
  checkNotesLength(input.text, BOT_NOTES_MAX);
  const outcome = await db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ revision: users.botNotesRevision, notes: users.botNotes })
      .from(users)
      .where(eq(users.id, input.botId))
      .for('update');
    if (!bot) throw new DomainError('not_found', 'bot not found', { reason: 'bot_not_found' });
    const [lease] = await tx
      .select({ seen: turnLeases.notesRevisionSeen })
      .from(turnLeases)
      .where(and(eq(turnLeases.id, input.leaseId), eq(turnLeases.botId, input.botId)))
      .for('update');
    // Gone since the caller checked it (deleted or settled): the turn is over.
    if (!lease) {
      throw new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });
    }
    if (lease.seen !== bot.revision) {
      await tx
        .update(turnLeases)
        .set({ notesRevisionSeen: bot.revision })
        .where(eq(turnLeases.id, input.leaseId));
      return { changed: bot.notes } as const;
    }
    const revision = bot.revision + 1;
    await tx
      .update(users)
      .set({ botNotes: input.text, botNotesRevision: revision })
      .where(eq(users.id, input.botId));
    await tx
      .update(turnLeases)
      .set({ notesRevisionSeen: revision })
      .where(eq(turnLeases.id, input.leaseId));
    return { revision } as const;
  });
  if ('changed' in outcome) {
    throw new DomainError('validation', 'notes changed', {
      reason: 'notes_changed',
      current: outcome.changed,
    });
  }
  return outcome;
}

/** Empties the bot's notes; the bump makes every lease's next write meet `notes_changed`. */
export async function clearBotNotes(tx: DbOrTx, botId: number): Promise<void> {
  await tx
    .update(users)
    .set({ botNotes: '', botNotesRevision: sql`${users.botNotesRevision} + 1` })
    .where(eq(users.id, botId));
}

/**
 * Replaces the bot's notes on the game. Once the game is over only its game-over turn may write
 * them (that turn's end deletes them); any other lease meets 'turn_ended'.
 */
export async function setMatchNotes(
  tx: DbOrTx,
  input: { botId: number; gameId: number; text: string; leaseKind: TurnKind },
): Promise<void> {
  checkNotesLength(input.text, MATCH_NOTES_MAX);
  await tx.transaction(async (inner) => {
    // Key share: an ending (which locks the game, then deletes notes) is waited for and seen.
    const [game] = await inner
      .select({ status: games.status })
      .from(games)
      .where(eq(games.id, input.gameId))
      .for('key share');
    if (!game || (game.status !== 'active' && input.leaseKind !== 'game_over')) {
      throw new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });
    }
    await inner
      .insert(matchNotes)
      .values({ botId: input.botId, gameId: input.gameId, body: input.text })
      .onConflictDoUpdate({
        target: [matchNotes.botId, matchNotes.gameId],
        set: { body: input.text },
      });
  });
}

export async function getMatchNotes(tx: DbOrTx, botId: number, gameId: number): Promise<string> {
  const [row] = await tx
    .select({ body: matchNotes.body })
    .from(matchNotes)
    .where(and(eq(matchNotes.botId, botId), eq(matchNotes.gameId, gameId)));
  return row?.body ?? '';
}
