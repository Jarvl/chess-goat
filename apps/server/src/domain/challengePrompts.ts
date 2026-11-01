import type { PromptSettings, PromptTime } from '@chess-goat/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challengePrompts } from '../db/schema';

const columns = (settings: PromptSettings) => ({
  timePerMove: settings.timePerMove,
  colour: settings.colour,
  rated: settings.rated,
});

const where = (groupId: number, userId: number) =>
  and(eq(challengePrompts.groupId, groupId), eq(challengePrompts.userId, userId));

/** A bare /challenge opens the prompt: its starting settings, and the topic its card belongs to. */
export async function openPromptRow(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  settings: PromptSettings,
  threadId: number | null,
): Promise<void> {
  const values = { ...columns(settings), threadId };
  await tx
    .insert(challengePrompts)
    .values({ groupId, userId, ...values })
    .onConflictDoUpdate({
      target: [challengePrompts.groupId, challengePrompts.userId],
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** Records the settings someone's prompt now shows, keeping the topic it was opened in. */
export async function savePromptSettings(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  settings: PromptSettings,
): Promise<void> {
  const values = columns(settings);
  await tx
    .insert(challengePrompts)
    .values({ groupId, userId, ...values })
    .onConflictDoUpdate({
      target: [challengePrompts.groupId, challengePrompts.userId],
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** What a prompt holds: the settings it shows, and the topic its card belongs to. */
export type StoredPrompt = { settings: PromptSettings; threadId: number | null };

/**
 * Takes someone's prompt to make its challenge. The delete is the claim: of two taps or replies at
 * once, only one gets the row. Null when there is none, or another update took it first.
 */
export async function claimPrompt(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<StoredPrompt | null> {
  const [row] = await tx.delete(challengePrompts).where(where(groupId, userId)).returning();
  if (!row) return null;
  return {
    settings: { timePerMove: row.timePerMove as PromptTime, colour: row.colour, rated: row.rated },
    threadId: row.threadId,
  };
}

/** Puts back a claimed prompt whose challenge was refused, unless a newer prompt replaced it. */
export async function restorePrompt(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  prompt: StoredPrompt,
): Promise<void> {
  await tx
    .insert(challengePrompts)
    .values({ groupId, userId, ...columns(prompt.settings), threadId: prompt.threadId })
    .onConflictDoNothing();
}
