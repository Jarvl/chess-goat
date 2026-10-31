import {
  t,
  type CallbackData,
  type GroupSettings,
  type MessageKey,
  type MessageParams,
} from '@chess-goat/shared';
import type { Api, ChatTypeContext, Composer, Context } from 'grammy';
import type { CallbackQuery, InlineKeyboardMarkup, Message, User } from 'grammy/types';
import { createChallenge, type CreateChallengeInput } from '../domain/challenges';
import {
  clearPromptSettings,
  getPrompt,
  openPromptRow,
  savePromptSettings,
} from '../domain/challengePrompts';
import type { Deps } from '../domain/deps';
import { getGroupByChatId, settingsOf } from '../domain/groups';
import { touchMember } from '../domain/members';
import { displayName, ensureUser, getUserByTelegramId } from '../domain/users';
import type { GroupRow, UserRow } from '../db/schema';
import { promptStateFrom, promptView, startingSettings } from './challengePrompt';
import { deleteEphemeral, editEphemeral, sendEphemeral, type EphemeralTrigger } from './ephemeral';
import { resolveOpponent } from './opponent';
import { replyFor } from './replies';
import { userInfo } from './userInfo';

// The bare /challenge prompt: who to play, and the game settings, chosen privately. Every call here
// goes through an unthrottled client: Telegram drops an ephemeral answer sent more than 15 s after
// the user's action, and the shared throttler can queue that long behind the job worker.

type PromptData = Extract<CallbackData, { action: 'prompt' }>;
type View = ReturnType<typeof promptView>;

/** grammY 1.46 has no types for ephemeral messages: they arrive with message_id 0 and this id. */
export const ephemeralIdOf = (message: object): number | null =>
  (message as { ephemeral_message_id?: number }).ephemeral_message_id ?? null;

export const threadOf = (message: Pick<Message, 'is_topic_message' | 'message_thread_id'>) =>
  message.is_topic_message ? (message.message_thread_id ?? null) : null;

/** Cards go to the topic the challenge was made in, or to the configured fixed topic (spec §5.8). */
export function cardThread(settings: GroupSettings, originThread: number | null): number | null {
  return settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : originThread;
}

/** Where an answer to one person goes, and how Telegram lets it be private. */
export type Answer = {
  chatId: number;
  threadId: number | null;
  receiverId: number;
  /** Null when Telegram allows no private answer here. */
  trigger: EphemeralTrigger | null;
  /** The message a public answer replies to; null when it has none (an ephemeral one). */
  replyToMessageId: number | null;
};

/** A cleanup step after the work is done: a failure must not fail the update into a retry. */
async function quietly(deps: Deps, step: Promise<unknown>): Promise<void> {
  try {
    await step;
  } catch (error) {
    deps.log.warn({ err: error }, 'prompt cleanup failed');
  }
}

/** One line for one person: private where Telegram allows it, otherwise a public reply. */
export async function sayPrivately(
  api: Api,
  answer: Answer,
  key: MessageKey,
  params: MessageParams = {},
): Promise<void> {
  const text = t(key, params);
  if (answer.trigger && (await sendEphemeral(api, { ...answer, trigger: answer.trigger, text })))
    return;
  await sayPublicly(api, answer, text);
}

/** The public fallback for a private line. */
async function sayPublicly(api: Api, answer: Answer, text: string): Promise<void> {
  await api.sendMessage(answer.chatId, text, {
    ...(answer.threadId !== null ? { message_thread_id: answer.threadId } : {}),
    ...(answer.replyToMessageId !== null
      ? {
          reply_parameters: {
            message_id: answer.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
}

/**
 * The prompt as a normal group message, when it cannot be private. It opens with the owner's name,
 * which `force_reply` needs to open the reply box for them alone; someone without a username is
 * named by a link to them.
 */
async function sendFallbackPrompt(
  api: Api,
  place: { chatId: number; threadId: number | null; owner: User },
  view: View,
): Promise<void> {
  const { owner } = place;
  const name = owner.username ? `@${owner.username}` : owner.first_name;
  await api.sendMessage(place.chatId, `${name}\n${view.text}`, {
    ...(place.threadId !== null ? { message_thread_id: place.threadId } : {}),
    ...(owner.username
      ? {}
      : { entities: [{ type: 'text_mention', offset: 0, length: name.length, user: owner }] }),
    reply_markup: view.replyMarkup as InlineKeyboardMarkup,
  });
}

/** A bare /challenge: the prompt at its starting settings, private when the bot is an admin. */
export async function openPrompt(
  deps: Deps,
  api: Api,
  input: { group: GroupRow; user: UserRow; from: User; chatId: number; threadId: number | null },
): Promise<void> {
  const { group, from } = input;
  const settings = startingSettings(settingsOf(group));
  await openPromptRow(deps.db, group.id, input.user.id, settings, input.threadId);
  const view = promptView('main', from.id, settings);
  // Only an admin bot may send an ephemeral message that answers nothing ephemeral.
  if (
    group.botIsAdmin &&
    (await sendEphemeral(api, {
      chatId: input.chatId,
      threadId: input.threadId,
      receiverId: from.id,
      trigger: { kind: 'none' },
      text: view.text,
      replyMarkup: view.replyMarkup,
    }))
  )
    return;
  await sendFallbackPrompt(
    api,
    { chatId: input.chatId, threadId: input.threadId, owner: from },
    view,
  );
}

/** Creates the challenge, or tells the challenger why not. True when it was created. */
export async function challengeOrExplain(
  deps: Deps,
  api: Api,
  answer: Answer,
  input: CreateChallengeInput,
): Promise<boolean> {
  try {
    await createChallenge(deps, input);
    return true;
  } catch (error) {
    const line = replyFor(error);
    if (!line) throw error;
    await sayPrivately(api, answer, line.key, line.params);
    return false;
  }
}

/** The prompt message: an ephemeral one, or the normal fallback. */
type PromptRef = { ephemeralMessageId: number } | { messageId: number };

const promptRefOf = (message: { message_id: number }): PromptRef => {
  const ephemeralMessageId = ephemeralIdOf(message);
  return ephemeralMessageId !== null ? { ephemeralMessageId } : { messageId: message.message_id };
};

// A fallback prompt (a normal message) is not edited or deleted here: it is cleaned up with the
// fallback's own deletion, which comes with its job.
async function editPrompt(
  api: Api,
  place: { chatId: number; owner: number },
  ref: PromptRef,
  view: View,
): Promise<void> {
  if (!('ephemeralMessageId' in ref)) return;
  await editEphemeral(api, {
    chatId: place.chatId,
    receiverId: place.owner,
    ephemeralMessageId: ref.ephemeralMessageId,
    text: view.text,
    replyMarkup: view.replyMarkup,
  });
}

async function deletePrompt(
  api: Api,
  place: { chatId: number; owner: number },
  ref: PromptRef,
): Promise<void> {
  if (!('ephemeralMessageId' in ref)) return;
  await deleteEphemeral(api, {
    chatId: place.chatId,
    receiverId: place.owner,
    ephemeralMessageId: ref.ephemeralMessageId,
  });
}

/** A tap on the prompt: only its owner may change the settings or post the open challenge. */
export async function handlePromptTap(
  deps: Deps,
  api: Api,
  query: CallbackQuery,
  data: PromptData,
): Promise<void> {
  const answer = (options?: { text: string; show_alert: boolean }) =>
    api.answerCallbackQuery(query.id, options);
  const message = query.message;
  const chat = message?.chat;
  if (!message || !chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await answer();
    return;
  }
  if (query.from.id !== data.ownerTelegramId) {
    const owner = await getUserByTelegramId(deps.db, data.ownerTelegramId);
    const name = owner ? displayName(owner) : 'the person who asked';
    await answer({ text: t('alert.not_your_prompt', { name }), show_alert: true });
    return;
  }
  const group = await getGroupByChatId(deps.db, chat.id);
  if (!group) {
    await answer();
    return;
  }
  const user = await ensureUser(deps.db, userInfo(query.from));
  await touchMember(deps.db, group.id, user.id);
  const place = { chatId: chat.id, owner: query.from.id };
  const ref = promptRefOf(message);
  if (data.op !== 'anyone') {
    await savePromptSettings(deps.db, group.id, user.id, data.settings);
    await editPrompt(api, place, ref, promptView(data.op, data.ownerTelegramId, data.settings));
    await answer();
    return;
  }
  // The topic comes from the command: an ephemeral tap may not say which topic it was in.
  const stored = await getPrompt(deps.db, group.id, user.id);
  const tappedThread = 'message_thread_id' in message ? threadOf(message) : null;
  const originThread = stored ? stored.threadId : tappedThread;
  try {
    await createChallenge(deps, {
      groupId: group.id,
      challengerId: user.id,
      opponentId: null,
      opponentUsername: null,
      timePerMove: data.settings.timePerMove,
      colour: data.settings.colour,
      rated: data.settings.rated,
      threadId: cardThread(settingsOf(group), originThread),
    });
  } catch (error) {
    // The prompt stays, so the owner can still pick someone.
    const line = replyFor(error);
    if (!line) throw error;
    await answer({ text: t(line.key, line.params), show_alert: true });
    return;
  }
  await clearPromptSettings(deps.db, group.id, user.id);
  await quietly(deps, deletePrompt(api, place, ref));
  await quietly(deps, answer());
}

/**
 * A reply to the prompt names the opponent. Only the owner's replies count; replies to any other bot
 * message pass on. The prompt in the reply may be a stale copy, so it gives only the owner, and the
 * settings come from the server's row.
 */
export function registerPromptReplies(
  groupChats: Composer<ChatTypeContext<Context, 'group' | 'supergroup'>>,
  deps: Deps,
  api: Api,
): void {
  groupChats.on('message:text', async (ctx, next) => {
    const msg = ctx.msg;
    const prompt = msg.reply_to_message;
    const state = prompt?.from?.id === ctx.me.id ? promptStateFrom(prompt.reply_markup) : null;
    if (!prompt || !state) return next();
    if (msg.sender_chat || msg.from.id !== state.owner) return;
    const group = await getGroupByChatId(deps.db, ctx.chat.id);
    if (!group) return;
    const user = await ensureUser(deps.db, userInfo(msg.from));
    await touchMember(deps.db, group.id, user.id);
    const ephemeralMessageId = ephemeralIdOf(msg);
    const threadId = threadOf(msg);
    const answer: Answer = {
      chatId: ctx.chat.id,
      threadId,
      receiverId: msg.from.id,
      // A reply to a private prompt is itself private; a reply to the fallback is a normal message.
      trigger: ephemeralMessageId !== null ? { ephemeralMessageId } : null,
      replyToMessageId: ephemeralMessageId !== null ? null : msg.message_id,
    };
    const choice = await resolveOpponent(deps, {
      groupId: group.id,
      challenger: msg.from,
      message: msg,
      botUsername: ctx.me.username,
      useReplyTarget: false,
    });
    if (choice.kind === 'none') return sayPrivately(api, answer, 'reply.pick_someone');
    if (choice.kind === 'refuse') return sayPrivately(api, answer, choice.key);
    const groupSettings = settingsOf(group);
    const stored = await getPrompt(deps.db, group.id, user.id);
    const settings = stored?.settings ?? startingSettings(groupSettings);
    const created = await challengeOrExplain(deps, api, answer, {
      groupId: group.id,
      challengerId: user.id,
      opponentId: choice.kind === 'user' ? choice.userId : null,
      opponentUsername: choice.kind === 'username' ? choice.username : null,
      timePerMove: settings.timePerMove,
      colour: settings.colour,
      rated: settings.rated,
      threadId: cardThread(groupSettings, stored ? stored.threadId : threadId),
    });
    if (!created) return;
    await clearPromptSettings(deps.db, group.id, user.id);
    await quietly(
      deps,
      deletePrompt(api, { chatId: ctx.chat.id, owner: msg.from.id }, promptRefOf(prompt)),
    );
  });
}
