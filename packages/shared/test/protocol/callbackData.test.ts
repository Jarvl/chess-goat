import { describe, expect, it } from 'vitest';
import {
  decodeCallbackData,
  encodeCallbackData,
  type CallbackData,
} from '../../src/protocol/callbackData';

describe('callback data codec', () => {
  it('encodes the three card actions', () => {
    expect(encodeCallbackData({ action: 'accept_challenge', challengeId: 'aZ09bY18cX' })).toBe(
      'ch/acc/aZ09bY18cX',
    );
    expect(encodeCallbackData({ action: 'decline_challenge', challengeId: 'aZ09bY18cX' })).toBe(
      'ch/dec/aZ09bY18cX',
    );
    expect(encodeCallbackData({ action: 'rematch', gameId: 'aZ09bY18cX' })).toBe(
      'gm/rem/aZ09bY18cX',
    );
  });

  it('decodes what it encodes', () => {
    const all: CallbackData[] = [
      { action: 'accept_challenge', challengeId: 'aZ09bY18cX' },
      { action: 'decline_challenge', challengeId: 'aZ09bY18cX' },
      { action: 'rematch', gameId: 'aZ09bY18cX' },
    ];
    for (const data of all) {
      expect(decodeCallbackData(encodeCallbackData(data))).toEqual(data);
    }
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['an unknown action', 'ch/xyz/aZ09bY18cX'],
    ['a short id', 'gm/rem/aZ09bY18c'],
    ['trailing data', 'gm/rem/aZ09bY18cX/extra'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeCallbackData(raw)).toBeNull();
  });
});
