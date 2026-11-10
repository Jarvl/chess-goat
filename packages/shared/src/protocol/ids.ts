import { z } from 'zod';

/** Public identifier of a game, group or challenge: ten base62 characters. */
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

export const PublicIdSchema = z.string().regex(PUBLIC_ID_PATTERN);

export type PublicId = z.infer<typeof PublicIdSchema>;

export function isPublicId(value: unknown): value is PublicId {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}

/** Internal user ids travel through the API as decimal strings without leading zeros. */
export const UserIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

export type UserId = z.infer<typeof UserIdSchema>;
