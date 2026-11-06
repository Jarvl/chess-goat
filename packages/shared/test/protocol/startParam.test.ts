import { describe, expect, it } from 'vitest';
import { decodeStartParam, encodeStartParam, type StartParam } from '../../src/protocol/startParam';

describe('start param codec', () => {
  it('encodes a game link payload', () => {
    expect(encodeStartParam({ kind: 'game', gameId: 'aZ09bY18cX' })).toBe('g_aZ09bY18cX');
  });

  it('encodes lobby, new game and settings payloads', () => {
    expect(encodeStartParam({ kind: 'lobby', groupId: 'aZ09bY18cX' })).toBe('l_aZ09bY18cX');
    expect(encodeStartParam({ kind: 'newGame', groupId: 'aZ09bY18cX' })).toBe('n_aZ09bY18cX');
    expect(encodeStartParam({ kind: 'settings', groupId: 'aZ09bY18cX' })).toBe('s_aZ09bY18cX');
  });

  it('encodes bots and challengeBot with the bot id in base36', () => {
    expect(encodeStartParam({ kind: 'bots', groupId: 'aZ09bY18cX' })).toBe('b_aZ09bY18cX');
    expect(encodeStartParam({ kind: 'challengeBot', groupId: 'aZ09bY18cX', botId: 35 })).toBe(
      'c_aZ09bY18cX_z',
    );
  });

  it('keeps the longest challengeBot param within Telegram startapp limits', () => {
    const longest = encodeStartParam({
      kind: 'challengeBot',
      groupId: 'aZ09bY18cX',
      botId: Number.MAX_SAFE_INTEGER,
    });
    expect(longest.length).toBeLessThanOrEqual(64);
    expect(longest).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('decodes what it encodes', () => {
    const params: StartParam[] = [
      { kind: 'game', gameId: 'aZ09bY18cX' },
      { kind: 'lobby', groupId: 'grp0000001' },
      { kind: 'newGame', groupId: 'grp0000001' },
      { kind: 'settings', groupId: 'grp0000001' },
      { kind: 'bots', groupId: 'grp0000001' },
      { kind: 'challengeBot', groupId: 'grp0000001', botId: 42 },
      { kind: 'challengeBot', groupId: 'grp0000001', botId: Number.MAX_SAFE_INTEGER },
    ];
    for (const param of params) {
      expect(decodeStartParam(encodeStartParam(param))).toEqual(param);
    }
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['an unknown prefix', 'x_aZ09bY18cX'],
    ['an upper-case prefix', 'G_aZ09bY18cX'],
    ['a short id', 'g_aZ09bY18c'],
    ['a long id', 'g_aZ09bY18cXX'],
    ['path characters', 'g_../../etc'],
    ['a missing underscore', 'gaZ09bY18cX'],
    ['bots with an extra part', 'b_aZ09bY18cX_z'],
    ['challengeBot without a bot', 'c_aZ09bY18cX'],
    ['challengeBot with an empty bot', 'c_aZ09bY18cX_'],
    ['a decimal bot id', 'c_aZ09bY18cX_1.5'],
    ['an upper-case bot id', 'c_aZ09bY18cX_AB'],
    ['a zero bot id', 'c_aZ09bY18cX_0'],
    ['a leading-zero bot id', 'c_aZ09bY18cX_0z'],
    ['an unsafe bot id', 'c_aZ09bY18cX_zzzzzzzzzzzz'],
    ['a short group in challengeBot', 'c_aZ09bY18c_z'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeStartParam(raw)).toBeNull();
  });
});
