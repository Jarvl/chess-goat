import type { Chat, InlineKeyboardMarkup, MessageEntity, Update, User } from 'grammy/types';

let updateId = 1000;
let messageId = 500;

export const tgUser = (id: number, first_name: string, username?: string): User => ({
  id,
  is_bot: false,
  first_name,
  ...(username ? { username } : {}),
});

export const supergroup = (id: number, title = 'Chess Club'): Chat.SupergroupChat => ({
  id,
  type: 'supergroup',
  title,
});

export const privateChat = (user: User): Chat.PrivateChat => ({
  id: user.id,
  type: 'private',
  first_name: user.first_name,
});

type ReplyTarget = { from?: User; senderChat?: boolean };

export function commandUpdate(options: {
  chat: Chat.SupergroupChat | Chat.GroupChat | Chat.PrivateChat;
  from: User;
  text: string;
  replyTo?: ReplyTarget;
  threadId?: number;
  /** Entities after the command's own, such as an @mention of the opponent. */
  entities?: MessageEntity[];
  /** Posted as an anonymous admin: Telegram sets sender_chat to the group itself. */
  senderChat?: boolean;
  /** An ephemeral message: message_id 0, identified by ephemeral_message_id instead. */
  ephemeral?: boolean;
}): Update {
  const command = options.text.split(' ')[0] ?? options.text;
  const base = { date: 1, chat: options.chat };
  return {
    update_id: (updateId += 1),
    message: {
      ...base,
      message_id: options.ephemeral ? 0 : (messageId += 1),
      ...(options.ephemeral ? { ephemeral_message_id: (messageId += 1) } : {}),
      from: options.from,
      ...(options.senderChat ? { sender_chat: options.chat } : {}),
      text: options.text,
      entities: [
        { type: 'bot_command', offset: 0, length: command.length },
        ...(options.entities ?? []),
      ],
      ...(options.threadId ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              ...base,
              message_id: (messageId += 1),
              ...(options.replyTo.from ? { from: options.replyTo.from } : {}),
              ...(options.replyTo.senderChat ? { sender_chat: options.chat } : {}),
              text: 'hi',
            },
          }
        : {}),
    },
  } as Update;
}

export function callbackUpdate(options: {
  from: User;
  chat: Chat.SupergroupChat;
  data: string;
  cardMessageId?: number;
  /** The tap is on an ephemeral message: message_id 0 plus its ephemeral_message_id. */
  ephemeralMessageId?: number;
  markup?: InlineKeyboardMarkup;
  threadId?: number;
}): Update {
  return {
    update_id: (updateId += 1),
    callback_query: {
      id: String(updateId),
      from: options.from,
      chat_instance: 'ci',
      data: options.data,
      message: {
        message_id: options.ephemeralMessageId !== undefined ? 0 : (options.cardMessageId ?? 1),
        ...(options.ephemeralMessageId !== undefined
          ? { ephemeral_message_id: options.ephemeralMessageId }
          : {}),
        date: 1,
        chat: options.chat,
        text: 'card',
        ...(options.threadId
          ? { message_thread_id: options.threadId, is_topic_message: true }
          : {}),
        ...(options.markup ? { reply_markup: options.markup } : {}),
      },
    },
  } as Update;
}

/** A user's reply to the bot's prompt (force_reply, or a tap-reply on an ephemeral prompt). */
export function promptReplyUpdate(options: {
  chat: Chat.SupergroupChat;
  from: User;
  text: string;
  entities?: MessageEntity[];
  prompt: {
    markup: InlineKeyboardMarkup;
    ephemeralMessageId?: number;
    messageId?: number;
  };
  threadId?: number;
  ephemeral?: boolean;
}): Update {
  const base = { date: 1, chat: options.chat };
  return {
    update_id: (updateId += 1),
    message: {
      ...base,
      message_id: options.ephemeral ? 0 : (messageId += 1),
      ...(options.ephemeral ? { ephemeral_message_id: (messageId += 1) } : {}),
      from: options.from,
      text: options.text,
      ...(options.entities ? { entities: options.entities } : {}),
      ...(options.threadId ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
      reply_to_message: {
        ...base,
        message_id:
          options.prompt.ephemeralMessageId !== undefined
            ? 0
            : (options.prompt.messageId ?? (messageId += 1)),
        ...(options.prompt.ephemeralMessageId !== undefined
          ? { ephemeral_message_id: options.prompt.ephemeralMessageId }
          : {}),
        from: { id: 424242, is_bot: true, first_name: 'Test Chess', username: 'TestChessBot' },
        text: 'prompt',
        reply_markup: options.prompt.markup,
      },
    },
  } as Update;
}

export function myChatMemberUpdate(options: {
  chat: Chat.SupergroupChat | Chat.PrivateChat;
  from: User;
  oldStatus: 'left' | 'kicked' | 'member' | 'administrator';
  newStatus: 'left' | 'kicked' | 'member' | 'administrator';
  canPin?: boolean;
}): Update {
  const bot = { id: 424242, is_bot: true, first_name: 'Test Chess', username: 'TestChessBot' };
  const member = (status: string) =>
    status === 'administrator'
      ? {
          status,
          user: bot,
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: false,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_pin_messages: options.canPin ?? false,
        }
      : { status, user: bot };
  return {
    update_id: (updateId += 1),
    my_chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: member(options.oldStatus),
      new_chat_member: member(options.newStatus),
    },
  } as Update;
}

export function chatMemberUpdate(options: {
  chat: Chat.SupergroupChat;
  from: User;
  user: User;
  newStatus: 'member' | 'left' | 'kicked' | 'administrator';
}): Update {
  return {
    update_id: (updateId += 1),
    chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: { status: 'left', user: options.user },
      new_chat_member: { status: options.newStatus, user: options.user },
    },
  } as Update;
}

export function serviceUpdate(chat: Chat, from: User, fields: Record<string, unknown>): Update {
  return {
    update_id: (updateId += 1),
    message: { message_id: (messageId += 1), date: 1, chat, from, ...fields },
  } as Update;
}

export function preCheckoutUpdate(options: {
  from: User;
  payload: string;
  totalAmount: number;
  currency?: string;
}): Update {
  updateId += 1;
  return {
    update_id: updateId,
    pre_checkout_query: {
      id: `pcq-${updateId}`,
      from: options.from,
      currency: options.currency ?? 'XTR',
      total_amount: options.totalAmount,
      invoice_payload: options.payload,
    },
  } as Update;
}
