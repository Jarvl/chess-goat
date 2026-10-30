import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/schema';
import { toPlayerRef } from '../../src/domain/players';

const HASH = 'a'.repeat(64);
const person = (overrides: Partial<UserRow>) =>
  ({
    id: 7,
    firstName: 'Alice',
    username: null,
    deletedAt: null,
    isEngine: false,
    photoHash: null,
    flairWorn: [],
    ...overrides,
  }) as UserRow;

describe('toPlayerRef photo url', () => {
  it("points at the player's stored photo", () => {
    expect(toPlayerRef(person({ photoHash: HASH }), null).photoUrl).toBe(
      `/api/avatars/${HASH}.jpg`,
    );
  });

  it('is null without a photo', () => {
    expect(toPlayerRef(person({ photoHash: null }), null).photoUrl).toBeNull();
  });

  it('is null for the bot, whatever its row holds', () => {
    expect(toPlayerRef(person({ isEngine: true, photoHash: HASH }), null).photoUrl).toBeNull();
  });

  it('is null for a deleted player', () => {
    expect(
      toPlayerRef(person({ deletedAt: new Date(), photoHash: HASH }), null).photoUrl,
    ).toBeNull();
  });
});

describe('toPlayerRef flair', () => {
  // Which flair is worn (slot order, retired ids, at most three, none for the deleted or the bot)
  // is wornFlair's, tested through flairEmoji in users.test.ts.
  it('carries the worn flair', () =>
    expect(toPlayerRef(person({ flairWorn: ['en_passant_win', 'rank_1500'] }), null).flair).toEqual(
      ['en_passant_win', 'rank_1500'],
    ));
});
