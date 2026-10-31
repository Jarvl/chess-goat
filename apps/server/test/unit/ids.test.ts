import { PUBLIC_ID_PATTERN } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { generatePublicId } from '../../src/db/ids';

describe('generatePublicId', () => {
  it('produces ten base62 characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePublicId()).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generatePublicId()));
    expect(ids.size).toBe(2000);
  });
});
