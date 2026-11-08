import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { userPhotos, users, type UserPhotoRow, type UserRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { can } from './playerKind';

/** Profile photos spec: a user seen again after this long has their photo checked again. */
export const PHOTO_REFRESH_SECONDS = 86_400;

export function photoHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Same origin as the Mini App, so its `img-src 'self'` covers it; the hash makes it immutable. */
export function avatarUrl(hash: string): string {
  return `/api/avatars/${hash}.jpg`;
}

export async function getPhotoRow(tx: DbOrTx, userId: number): Promise<UserPhotoRow | null> {
  const [row] = await tx.select().from(userPhotos).where(eq(userPhotos.userId, userId));
  return row ?? null;
}

/** Queues a photo check for a person the bot has not checked within a day (profile photos spec). */
export async function queuePhotoRefresh(
  tx: DbOrTx,
  user: Pick<UserRow, 'id' | 'isEngine' | 'ownerId' | 'deletedAt'>,
): Promise<void> {
  if (!can(user, 'showPhoto') || user.deletedAt) return;
  const [row] = await tx
    .select({
      fresh: sql<boolean>`${userPhotos.checkedAt} > now() - make_interval(secs => ${PHOTO_REFRESH_SECONDS})`,
    })
    .from(userPhotos)
    .where(eq(userPhotos.userId, user.id));
  if (row?.fresh) return;
  await enqueue(tx, {
    kind: 'fetch_user_photo',
    payload: { userId: user.id },
    dedupKey: `photo:${user.id}`,
    // A pending check keeps its backoff: seeing the user again is not a new reason to ask Telegram.
    rearm: false,
  });
}

/** The current photo, or null for "checked, none"; `users.photo_hash` follows in the same write. */
export async function storePhoto(
  tx: DbOrTx,
  userId: number,
  photo: { fileUniqueId: string; bytes: Buffer } | null,
): Promise<void> {
  const fields = {
    fileUniqueId: photo?.fileUniqueId ?? null,
    hash: photo ? photoHash(photo.bytes) : null,
    bytes: photo?.bytes ?? null,
    checkedAt: sql`now()`,
  };
  await tx
    .insert(userPhotos)
    .values({ userId, ...fields })
    .onConflictDoUpdate({ target: userPhotos.userId, set: fields });
  await tx.update(users).set({ photoHash: fields.hash }).where(eq(users.id, userId));
}

/** The photo Telegram reports is the one already stored: only the check time moves. */
export async function touchPhoto(tx: DbOrTx, userId: number): Promise<void> {
  await tx
    .update(userPhotos)
    .set({ checkedAt: sql`now()` })
    .where(eq(userPhotos.userId, userId));
}

export async function deletePhoto(tx: DbOrTx, userId: number): Promise<void> {
  await tx.delete(userPhotos).where(eq(userPhotos.userId, userId));
  await tx.update(users).set({ photoHash: null }).where(eq(users.id, userId));
}

/** Any row with this hash will do: the bytes are identical by definition. */
export async function getPhotoBytes(tx: DbOrTx, hash: string): Promise<Buffer | null> {
  const [row] = await tx
    .select({ bytes: userPhotos.bytes })
    .from(userPhotos)
    .where(eq(userPhotos.hash, hash))
    .limit(1);
  return row?.bytes ?? null;
}
