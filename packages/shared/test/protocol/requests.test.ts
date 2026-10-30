import { describe, expect, it } from 'vitest';
import {
  ChallengeRequestSchema,
  GroupSettingsUpdateRequestSchema,
  LaunchRequestSchema,
  MoveRequestSchema,
  PrefsUpdateRequestSchema,
  PremoveTreeRequestSchema,
  TelemetryRequestSchema,
  TipRequestSchema,
  TIP_MIN_STARS,
  TIP_MAX_STARS,
} from '../../src/protocol/requests';

describe('MoveRequestSchema', () => {
  const valid = { uci: 'e7e8q', expectedPly: 0, clientMoveId: 'abcdefgh' };

  it('accepts a promotion move with a client move id', () => {
    expect(MoveRequestSchema.parse(valid)).toEqual({ ...valid, premoveTree: '' });
  });

  it('defaults the premove tree to empty and keeps a sent one', () => {
    expect(MoveRequestSchema.parse(valid).premoveTree).toBe('');
    expect(MoveRequestSchema.parse({ ...valid, premoveTree: 'AQwH' }).premoveTree).toBe('AQwH');
    expect(MoveRequestSchema.safeParse({ ...valid, premoveTree: 'AQ+H' }).success).toBe(false);
  });

  it.each([
    ['an off-board square', { ...valid, uci: 'e7e9' }],
    ['a fractional ply', { ...valid, expectedPly: 1.5 }],
    ['a short client move id', { ...valid, clientMoveId: 'abc' }],
    ['a client move id with a space', { ...valid, clientMoveId: 'abcd efgh' }],
  ])('rejects %s', (_label, body) => {
    expect(MoveRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ChallengeRequestSchema', () => {
  it('accepts an open challenge', () => {
    const body = { opponentId: null, timePerMove: 86400, colour: 'random', rated: true };
    expect(ChallengeRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a time control that is not offered', () => {
    const body = { opponentId: '7', timePerMove: 7200, colour: 'white', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown colour', () => {
    const body = { opponentId: '7', timePerMove: 3600, colour: 'pink', rated: false };
    expect(ChallengeRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('TelemetryRequestSchema', () => {
  it('accepts one event', () => {
    const body = { events: [{ kind: 'sse_failed', durationMs: 30000 }] };
    expect(TelemetryRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(TelemetryRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects more than ten events', () => {
    const events = Array.from({ length: 11 }, () => ({ kind: 'move_retry' }));
    expect(TelemetryRequestSchema.safeParse({ events }).success).toBe(false);
  });
});

describe('PrefsUpdateRequestSchema', () => {
  it('accepts a partial preferences update', () => {
    expect(PrefsUpdateRequestSchema.parse({ prefs: { notifications: false } })).toEqual({
      prefs: { notifications: false },
    });
  });

  it('accepts a write-access prompt result on its own', () => {
    expect(PrefsUpdateRequestSchema.parse({ writeAccess: { allowed: true } })).toEqual({
      writeAccess: { allowed: true },
    });
  });

  it('accepts a move confirmations change and refuses an unknown one', () => {
    expect(PrefsUpdateRequestSchema.parse({ prefs: { moveConfirmations: 'never' } })).toEqual({
      prefs: { moveConfirmations: 'never' },
    });
    expect(
      PrefsUpdateRequestSchema.safeParse({ prefs: { moveConfirmations: 'sometimes' } }).success,
    ).toBe(false);
  });
});

describe('GroupSettingsUpdateRequestSchema', () => {
  it('accepts a single field', () => {
    expect(GroupSettingsUpdateRequestSchema.parse({ ratedDefault: false })).toEqual({
      ratedDefault: false,
    });
  });

  it('still enforces the range of each field', () => {
    expect(GroupSettingsUpdateRequestSchema.safeParse({ fixedTopicId: -1 }).success).toBe(false);
  });
});

describe('LaunchRequestSchema', () => {
  it('rejects empty init data', () => {
    expect(LaunchRequestSchema.safeParse({ initData: '' }).success).toBe(false);
  });
});

describe('TipRequestSchema', () => {
  it.each([TIP_MIN_STARS, 250, TIP_MAX_STARS])('accepts %s stars', (stars) => {
    expect(TipRequestSchema.parse({ stars })).toEqual({ stars });
  });

  it.each([
    ['zero', 0],
    ['a negative amount', -5],
    ['too many', 10_001],
    ['a fraction', 2.5],
    ['a numeric string', '100'],
    ['nothing', undefined],
  ])('rejects %s', (_label, stars) => {
    expect(TipRequestSchema.safeParse({ stars }).success).toBe(false);
  });
});

describe('PremoveTreeRequestSchema', () => {
  const valid = { baseHash: 'A'.repeat(43), tree: 'AQwH', expectedPly: 3 };

  it('accepts a 43-char base hash, including with an empty tree', () => {
    expect(PremoveTreeRequestSchema.parse(valid)).toEqual(valid);
    expect(PremoveTreeRequestSchema.parse({ ...valid, tree: '' }).tree).toBe('');
  });

  it.each([
    ['a 42-char base hash', { ...valid, baseHash: 'A'.repeat(42) }],
    ['a 44-char base hash', { ...valid, baseHash: 'A'.repeat(44) }],
    ['a plus sign in the tree', { ...valid, tree: 'AQ+H' }],
    ['padding in the tree', { ...valid, tree: 'AQwH==' }],
    ['a missing ply', { baseHash: valid.baseHash, tree: valid.tree }],
    ['a negative ply', { ...valid, expectedPly: -1 }],
  ])('rejects %s', (_label, body) => {
    expect(PremoveTreeRequestSchema.safeParse(body).success).toBe(false);
  });
});
