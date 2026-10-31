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

export async function getPrompt(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<{ settings: PromptSettings; threadId: number | null } | null> {
  const [row] = await tx.select().from(challengePrompts).where(where(groupId, userId)).limit(1);
  if (!row) return null;
  return {
    settings: { timePerMove: row.timePerMove as PromptTime, colour: row.colour, rated: row.rated },
    threadId: row.threadId,
  };
}

export async function clearPromptSettings(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<void> {
  await tx.delete(challengePrompts).where(where(groupId, userId));
}
