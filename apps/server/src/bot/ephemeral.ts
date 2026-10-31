import { GrammyError, HttpError, type Api } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';

// Ephemeral messages (Bot API 10.2/10.3) are group messages only one user sees. grammY 1.46 has no
// types for them, so these go through the raw API and carry their own markup types.

export type EphemeralButton = InlineKeyboardButton & { style?: 'primary' | 'success' | 'danger' };
export type EphemeralMarkup = Omit<InlineKeyboardMarkup, 'inline_keyboard'> & {
  inline_keyboard: EphemeralButton[][];
  force_reply?: boolean;
};

export type EphemeralTrigger =
  | { ephemeralMessageId: number } // the user's ephemeral command or reply
  | { callbackQueryId: string } // a tap
  | { kind: 'none' }; // nothing: only an admin bot may send unprompted

type RawCalls = Record<string, (payload: object) => Promise<unknown>>;
const raw = (api: Api) => api.raw as unknown as RawCalls;

/**
 * Posts a message only `receiverId` sees. Null when it fails, so the caller can answer publicly;
 * a 429 is rethrown, so the update retries instead of going public.
 */
export async function sendEphemeral(
  api: Api,
  input: {
    chatId: number;
    threadId: number | null;
    receiverId: number;
    trigger: EphemeralTrigger;
    text: string;
    replyMarkup?: EphemeralMarkup;
  },
): Promise<{ ephemeralMessageId: number } | null> {
  const { trigger } = input;
  try {
    const message = (await raw(api).sendMessage!({
      chat_id: input.chatId,
      ...(input.threadId !== null ? { message_thread_id: input.threadId } : {}),
      text: input.text,
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      ephemeral_message_parameters: {
        receiver_user_id: input.receiverId,
        ...('callbackQueryId' in trigger ? { callback_query_id: trigger.callbackQueryId } : {}),
      },
      ...('ephemeralMessageId' in trigger
        ? { reply_parameters: { ephemeral_message_id: trigger.ephemeralMessageId } }
        : {}),
    })) as { ephemeral_message_id: number };
    return { ephemeralMessageId: message.ephemeral_message_id };
  } catch (error) {
    if (error instanceof GrammyError && error.error_code !== 429) return null;
    if (error instanceof HttpError) return null;
    throw error;
  }
}

async function swallowGone(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (
      error instanceof GrammyError &&
      error.error_code === 400 &&
      /message to (edit|delete) not found/i.test(error.description)
    )
      return;
    throw error;
  }
}

export function editEphemeral(
  api: Api,
  input: {
    chatId: number;
    receiverId: number;
    ephemeralMessageId: number;
    text: string;
    replyMarkup: EphemeralMarkup;
  },
): Promise<void> {
  return swallowGone(
    raw(api).editEphemeralMessageText!({
      chat_id: input.chatId,
      receiver_user_id: input.receiverId,
      ephemeral_message_id: input.ephemeralMessageId,
      text: input.text,
      reply_markup: input.replyMarkup,
    }),
  );
}

export function deleteEphemeral(
  api: Api,
  input: { chatId: number; receiverId: number; ephemeralMessageId: number },
): Promise<void> {
  return swallowGone(
    raw(api).deleteEphemeralMessage!({
      chat_id: input.chatId,
      receiver_user_id: input.receiverId,
      ephemeral_message_id: input.ephemeralMessageId,
    }),
  );
}
