import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { classifyTelegramError } from '../../src/telegram/client';

function grammyError(
  error_code: number,
  description: string,
  parameters: Record<string, number> = {},
) {
  return new GrammyError(
    'Call failed',
    { ok: false, error_code, description, parameters },
    'sendMessage',
    {},
  );
}

describe('classifyTelegramError', () => {
  it.each([
    [
      'a 429',
      grammyError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }),
      { kind: 'retry_after', seconds: 7 },
    ],
    [
      'not modified',
      grammyError(400, 'Bad Request: message is not modified: specified new message content'),
      { kind: 'not_modified' },
    ],
    [
      'message gone',
      grammyError(400, 'Bad Request: message to edit not found'),
      { kind: 'message_gone' },
    ],
    ['blocked', grammyError(403, 'Forbidden: bot was blocked by the user'), { kind: 'blocked' }],
    ['deactivated', grammyError(403, 'Forbidden: user is deactivated'), { kind: 'blocked' }],
    [
      'kicked',
      grammyError(403, 'Forbidden: bot was kicked from the supergroup chat'),
      { kind: 'chat_gone' },
    ],
    ['chat not found', grammyError(400, 'Bad Request: chat not found'), { kind: 'chat_gone' }],
    [
      'migrated',
      grammyError(400, 'Bad Request: group chat was upgraded to a supergroup chat', {
        migrate_to_chat_id: -1001,
      }),
      { kind: 'migrated', newChatId: -1001 },
    ],
    [
      'anything else',
      grammyError(400, 'Bad Request: wrong file identifier'),
      { kind: 'other', description: 'Bad Request: wrong file identifier' },
    ],
  ])('classifies %s', (_label, error, expected) => {
    expect(classifyTelegramError(error)).toEqual(expected);
  });

  it('returns null for errors that did not come from Telegram', () => {
    expect(classifyTelegramError(new Error('ECONNRESET'))).toBeNull();
  });
});
