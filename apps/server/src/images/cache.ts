import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { boardImages } from '../db/schema';

/**
 * Identical cards share a Telegram file id, and anything the card shows (the
 * theme included) changes the key. Rows keyed the old per-position way are simply never hit again.
 */
export function snapshotImageKey(svg: string): string {
  return createHash('sha256').update(svg).digest('hex');
}

export async function getCachedFileId(tx: DbOrTx, key: string): Promise<string | null> {
  const [row] = await tx
    .select({ fileId: boardImages.telegramFileId })
    .from(boardImages)
    .where(eq(boardImages.key, key));
  return row?.fileId ?? null;
}

export async function storeFileId(tx: DbOrTx, key: string, fileId: string): Promise<void> {
  await tx.insert(boardImages).values({ key, telegramFileId: fileId }).onConflictDoNothing();
}
