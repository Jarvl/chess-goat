import { describe, expect, it } from 'vitest';
import {
  ENGINE_LEVELS,
  MOVE_CONFIRMATIONS,
  TIME_PER_MOVE_OPTIONS,
  TimePerMoveSchema,
  isRatedEndReason,
  opposite,
} from '../../src/protocol/enums';

describe('TimePerMoveSchema', () => {
  // Every option the time pickers offer, so the list and the schema cannot drift apart.
  it.each([...TIME_PER_MOVE_OPTIONS, null])('accepts %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, 7200, 86400.5, '86400', undefined])('rejects %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(false);
  });
});

// The pickers show these in this order.
describe('display order', () => {
  it('lists the four engine levels weakest first', () => {
    expect(ENGINE_LEVELS).toEqual(['beginner', 'casual', 'club', 'strong']);
  });

  it('lists the three move confirmation settings, most confirming first', () => {
    expect(MOVE_CONFIRMATIONS).toEqual(['always', 'people', 'never']);
  });
});

describe('opposite', () => {
  it('flips the colour', () => {
    expect(opposite('white')).toBe('black');
    expect(opposite('black')).toBe('white');
  });
});

describe('isRatedEndReason', () => {
  it.each([
    'checkmate',
    'stalemate',
    'insufficient_material',
    'fivefold_repetition',
    'seventy_five_moves',
    'threefold_claim',
    'fifty_move_claim',
    'draw_agreement',
    'resignation',
    'timeout',
  ] as const)('%s changes ratings', (reason) => {
    expect(isRatedEndReason(reason)).toBe(true);
  });

  it.each(['timeout_abort', 'abort', 'voided'] as const)('%s leaves ratings alone', (reason) => {
    expect(isRatedEndReason(reason)).toBe(false);
  });
});
