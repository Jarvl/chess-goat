import type { Config } from '../../config';
import type { Deps } from '../../domain/deps';
import { markBotLeft } from '../../domain/groupLifecycle';
import { migrateChatId } from '../../domain/groups';
import {
  classifyTelegramError,
  type TelegramApi,
  type TelegramFailure,
} from '../../telegram/client';
import type { JobResult } from '../types';

/** One Bot API call with the chat-level consequences, shared by every Telegram job. */

export type TelegramHandlerContext = { deps: Deps; api: TelegramApi; config: Config };

export type CallResult<T> = { ok: true; value: T } | { ok: false; failure: TelegramFailure };

/** Runs one Bot API call and applies the chat-level consequences */
export async function call<T>(
  ctx: TelegramHandlerContext,
  chatId: number | null,
  fn: () => Promise<T>,
): Promise<CallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const failure = classifyTelegramError(error);
    if (!failure) throw error;
    if (chatId !== null && failure.kind === 'chat_gone') await markBotLeft(ctx.deps, chatId);
    if (chatId !== null && failure.kind === 'migrated')
      await migrateChatId(ctx.deps.db, chatId, failure.newChatId);
    return { ok: false, failure };
  }
}

/** Job outcome for a failure; `'throw'` means count an attempt and back off. */
export function telegramFailureOutcome(failure: TelegramFailure): JobResult | 'throw' {
  switch (failure.kind) {
    case 'retry_after':
      return {
        outcome: 'retry',
        delayMs: failure.seconds * 1000,
        error: `telegram 429: retry after ${failure.seconds}s`,
      };
    case 'migrated':
      return { outcome: 'retry', delayMs: 1000, error: 'chat migrated' };
    case 'not_modified':
    case 'message_gone':
    case 'blocked':
    case 'chat_gone':
      return { outcome: 'done' };
    case 'other':
      return 'throw';
  }
}

export function settle(result: CallResult<unknown>): JobResult {
  if (result.ok) return { outcome: 'done' };
  const outcome = telegramFailureOutcome(result.failure);
  if (outcome === 'throw')
    throw new Error(`telegram: ${(result.failure as { description: string }).description}`);
  return outcome;
}
