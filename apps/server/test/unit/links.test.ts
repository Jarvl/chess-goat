import { describe, expect, it } from 'vitest';
import { groupMessageLink, miniAppLink } from '../../src/telegram/links';

const config = { BOT_USERNAME: 'GroupChessBot', MINI_APP_SHORT_NAME: 'chess' };

describe('miniAppLink', () => {
  it('builds direct links with and without a payload', () => {
    expect(miniAppLink(config)).toBe('https://t.me/GroupChessBot/chess');
    expect(miniAppLink(config, { kind: 'game', gameId: 'aZ09bY18cX' })).toBe(
      'https://t.me/GroupChessBot/chess?startapp=g_aZ09bY18cX',
    );
  });
});

describe('groupMessageLink', () => {
  it('links to a message in a supergroup and to nothing in a basic group', () => {
    expect(groupMessageLink(-1001234567890, 42)).toBe('https://t.me/c/1234567890/42');
    expect(groupMessageLink(-987654321, 42)).toBeNull();
  });
});
