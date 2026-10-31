import type { PromptSettings, PromptTime } from '@chess-goat/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challengePrompts } from '../db/schema';

const where = (groupId: number, userId: number) =>
  and(eq(challengePrompts.groupId, groupId), eq(challengePrompts.userId, userId));

/** Records the settings someone's /challenge prompt in a group now shows. */
export async function savePromptSettings(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  settings: PromptSettings,
): Promise<void> {
  const values = {
    timePerMove: settings.timePerMove,
    colour: settings.colour,
    rated: settings.rated,
  };
  await tx
    .insert(challengePrompts)
    .values({ groupId, userId, ...values })
    .onConflictDoUpdate({
      target: [challengePrompts.groupId, challengePrompts.userId],
      set: { ...values, updatedAt: sql`now()` },
    });
}

export async function getPromptSettings(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<PromptSettings | null> {
  const [row] = await tx.select().from(challengePrompts).where(where(groupId, userId)).limit(1);
  if (!row) return null;
  return { timePerMove: row.timePerMove as PromptTime, colour: row.colour, rated: row.rated };
}

export async function clearPromptSettings(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<void> {
  await tx.delete(challengePrompts).where(where(groupId, userId));
}
