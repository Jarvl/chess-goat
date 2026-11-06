import { describe, expect, it } from 'vitest';
import {
  compactDuration,
  deadlineAfterMove,
  formatClock,
  formatTimeLeft,
  reminderAt,
} from '../src/clock';

const now = new Date('2026-09-20T10:00:00.000Z');

describe('deadlineAfterMove', () => {
  it('adds the time per move', () => {
    expect(deadlineAfterMove(now, 86400)?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it('has no deadline without a clock', () => {
    expect(deadlineAfterMove(now, null)).toBeNull();
  });
});

describe('reminderAt', () => {
  const deadline = new Date('2026-09-21T10:00:00.000Z');

  it('falls at ten percent of the time control before the deadline', () => {
    expect(reminderAt(deadline, 86400, true)?.toISOString()).toBe('2026-09-21T07:36:00.000Z');
    expect(reminderAt(new Date('2026-09-20T18:00:00.000Z'), 28800, true)?.toISOString()).toBe(
      '2026-09-20T17:12:00.000Z',
    );
  });

  it('is skipped for controls under eight hours', () => {
    expect(reminderAt(new Date('2026-09-20T11:00:00.000Z'), 3600, true)).toBeNull();
  });

  it('is skipped when the player has not allowed DMs', () => {
    expect(reminderAt(deadline, 86400, false)).toBeNull();
  });

  it('is skipped without a clock', () => {
    expect(reminderAt(null, null, true)).toBeNull();
  });
});

describe('formatTimeLeft', () => {
  it.each([
    [3 * 86_400_000 + 1000, '3 d'],
    [23 * 3_600_000 + 59 * 60_000, '23 h'],
    [45 * 60_000, '45 min'],
    [30_000, '30 s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatTimeLeft(ms)).toBe(expected);
  });

  it('formats a passed deadline as zero', () => {
    expect(formatTimeLeft(-5000)).toBe('0 s');
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [59_999, '0:59'],
    [65_000, '1:05'],
    [3_661_000, '1:01:01'],
    [90_061_000, '1d 1:01'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });

  it('formats a passed deadline as zero', () => {
    expect(formatClock(-1000)).toBe('0:00');
  });
});

describe('compactDuration', () => {
  it('uses the largest whole unit, minutes at least', () => {
    expect(compactDuration(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d');
    expect(compactDuration(5 * 3_600_000 + 59 * 60_000)).toBe('5h');
    expect(compactDuration(12 * 60_000)).toBe('12m');
    expect(compactDuration(5_000)).toBe('0m');
    expect(compactDuration(-1)).toBe('0m');
  });
});
