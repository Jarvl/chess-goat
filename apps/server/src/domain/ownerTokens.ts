import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { ownerTokens, users, type UserRow } from '../db/schema';
import { lockLiveHumanOwner } from './users';

export const OWNER_TOKEN_PREFIX = 'cgbot_';
/** 32 random bytes in base64url, unpadded. */
const TOKEN_BODY_LENGTH = 43;
const BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** Creates the owner's token, replacing any existing one. Returns the plaintext once. */
export async function createOwnerToken(tx: DbOrTx, userId: number): Promise<string> {
  await lockLiveHumanOwner(tx, userId);
  const token = OWNER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  await tx
    .insert(ownerTokens)
    .values({ userId, tokenHash })
    .onConflictDoUpdate({
      target: ownerTokens.userId,
      set: { tokenHash, createdAt: sql`now()`, lastUsedAt: null },
    });
  return token;
}

export async function revokeOwnerToken(tx: DbOrTx, userId: number): Promise<void> {
  await tx.delete(ownerTokens).where(eq(ownerTokens.userId, userId));
}

export async function ownerTokenStatus(
  tx: DbOrTx,
  userId: number,
): Promise<{ createdAt: Date; lastUsedAt: Date | null } | null> {
  const [row] = await tx
    .select({ createdAt: ownerTokens.createdAt, lastUsedAt: ownerTokens.lastUsedAt })
    .from(ownerTokens)
    .where(eq(ownerTokens.userId, userId));
  return row ?? null;
}

/** The live human owning `presented`, or null. Touches `lastUsedAt` at most once a minute. */
export async function resolveOwnerToken(tx: DbOrTx, presented: string): Promise<UserRow | null> {
  const token = presented.trim();
  if (!token.startsWith(OWNER_TOKEN_PREFIX)) return null;
  const body = token.slice(OWNER_TOKEN_PREFIX.length);
  if (body.length !== TOKEN_BODY_LENGTH || !BODY_PATTERN.test(body)) return null;

  const [row] = await tx
    .select({ user: users })
    .from(ownerTokens)
    .innerJoin(users, eq(users.id, ownerTokens.userId))
    .where(and(eq(ownerTokens.tokenHash, hashToken(token)), isNull(users.deletedAt)));
  if (!row) return null;

  await tx
    .update(ownerTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(ownerTokens.userId, row.user.id),
        sql`(${ownerTokens.lastUsedAt} is null or ${ownerTokens.lastUsedAt} < now() - interval '1 minute')`,
      ),
    );
  return row.user;
}
