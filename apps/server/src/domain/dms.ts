import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { dmMessages, type DmKind, type DmMessageRow } from '../db/schema';
import { enqueue } from '../jobs/queue';

/**
 * The live DM rows. Every function runs inside the caller's transaction,
 * so the row and the job that acts on its message commit together.
 */

export const retireDmPayload = z.object({
  userId: z.number().int(),
  chatId: z.number().int(),
  telegramMessageId: z.number().int(),
  sentAt: z.string(),
  action: z.enum(['retire', 'wait']),
  text: z.string().min(1),
  gameId: z.number().int().optional(),
});
export type RetireDmPayload = z.infer<typeof retireDmPayload>;

/** One job per message: a later retire overrides a pending waiting edit of the same message. */
async function enqueueForMessage(
  tx: DbOrTx,
  row: DmMessageRow,
  action: RetireDmPayload['action'],
  text: string,
): Promise<void> {
  const payload: RetireDmPayload = {
    userId: row.userId,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    sentAt: row.sentAt.toISOString(),
    action,
    text,
    ...(action === 'wait' && row.gameId !== null ? { gameId: row.gameId } : {}),
  };
  await enqueue(tx, {
    kind: 'retire_dm',
    payload,
    dedupKey: `dmmsg:${row.chatId}:${row.telegramMessageId}`,
    mergePayload: true,
  });
}

function subject(row: { gameId?: number | null; challengeId?: number | null }) {
  return row.gameId != null
    ? eq(dmMessages.gameId, row.gameId)
    : eq(dmMessages.challengeId, row.challengeId!);
}

export type NewDm = {
  userId: number;
  chatId: number;
  gameId?: number;
  challengeId?: number;
  telegramMessageId: number;
  kind: DmKind;
  stub: string;
};

/**
 * Makes `dm` the user's live DM for its game or challenge, and retires the one it replaces with
 * that one's own stub. Returns the new row.
 */
export async function recordDm(tx: DbOrTx, dm: NewDm): Promise<DmMessageRow> {
  const old = await tx
    .delete(dmMessages)
    .where(and(eq(dmMessages.userId, dm.userId), subject(dm)))
    .returning();
  const [row] = await tx
    .insert(dmMessages)
    .values({
      userId: dm.userId,
      chatId: dm.chatId,
      gameId: dm.gameId ?? null,
      challengeId: dm.challengeId ?? null,
      telegramMessageId: dm.telegramMessageId,
      kind: dm.kind,
      stub: dm.stub,
      // The database clock, which `retire_dm` measures the 47 hours against.
      sentAt: sql`now()`,
    })
    .returning();
  if (!row) throw new Error('dm_messages insert returned no row');
  for (const previous of old) await enqueueForMessage(tx, previous, 'retire', previous.stub);
  return row;
}

async function retireWhere(
  tx: DbOrTx,
  where: ReturnType<typeof eq>,
  stubFor: (row: DmMessageRow) => string,
): Promise<void> {
  const removed = await tx.delete(dmMessages).where(where).returning();
  for (const row of removed) await enqueueForMessage(tx, row, 'retire', stubFor(row));
}

/** Removes every live row for the game and retires each message (stub defaults to the row's own). */
export function retireGameDms(
  tx: DbOrTx,
  gameId: number,
  stubFor: (row: DmMessageRow) => string = (row) => row.stub,
): Promise<void> {
  return retireWhere(tx, eq(dmMessages.gameId, gameId), stubFor);
}

export function retireChallengeDms(tx: DbOrTx, challengeId: number, stub: string): Promise<void> {
  return retireWhere(tx, eq(dmMessages.challengeId, challengeId), () => stub);
}

export function retireUserDms(tx: DbOrTx, userId: number, stub: string): Promise<void> {
  return retireWhere(tx, eq(dmMessages.userId, userId), () => stub);
}

/** After the user moves, their live DM becomes the waiting line, silently. */
export async function markWaiting(
  tx: DbOrTx,
  p: { userId: number; gameId: number; text: string },
): Promise<void> {
  const [row] = await tx
    .update(dmMessages)
    .set({ kind: 'waiting', stub: p.text })
    .where(and(eq(dmMessages.userId, p.userId), eq(dmMessages.gameId, p.gameId)))
    .returning();
  if (row) await enqueueForMessage(tx, row, 'wait', p.text);
}

/** The user blocked the bot: nothing can be edited or deleted any more, so just forget the rows. */
export async function dropUserDms(tx: DbOrTx, userId: number): Promise<void> {
  await tx.delete(dmMessages).where(eq(dmMessages.userId, userId));
}
