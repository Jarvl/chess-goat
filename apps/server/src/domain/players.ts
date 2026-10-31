import { GLICKO2, isProvisional, type PlayerRef } from '@chess-goat/shared';
import type { RatingRow, UserRow } from '../db/schema';
import { avatarUrl } from './photos';
import { displayName, wornFlair } from './users';

/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<
    UserRow,
    'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine' | 'photoHash' | 'flairWorn'
  >,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
    isBot: user.isEngine,
    photoUrl:
      user.photoHash && !user.isEngine && !user.deletedAt ? avatarUrl(user.photoHash) : null,
    // One bad row with a fourth flair would break every screen showing them (see `wornFlair`).
    flair: wornFlair(user).map((flair) => flair.id),
  };
}
