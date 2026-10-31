import type { MessageKey } from '@chess-goat/shared';
import type { Message, User } from 'grammy/types';
import type { Deps } from '../domain/deps';
import { findMemberByUsername, touchMember } from '../domain/members';
import { ensureUser } from '../domain/users';
import { userInfo } from './userInfo';

export type OpponentChoice =
  | { kind: 'user'; userId: number }
  /** Lower-case, no `@`: a username this group has not shown the bot. */
  | { kind: 'username'; username: string }
  | { kind: 'refuse'; key: Extract<MessageKey, 'reply.bot' | 'reply.self' | 'reply.anonymous'> }
  | { kind: 'none' };

/** Records someone the message points at as a member, and names them as the opponent. */
async function memberChoice(deps: Deps, groupId: number, person: User): Promise<OpponentChoice> {
  const opponent = await ensureUser(deps.db, userInfo(person));
  await touchMember(deps.db, groupId, opponent.id);
  return { kind: 'user', userId: opponent.id };
}

/**
 * Who a /challenge, or a reply to its prompt, names. An @mention names the opponent more
 * deliberately than the message it replies to, so the first mention wins; the reply target counts
 * only when `useReplyTarget`.
 */
export async function resolveOpponent(
  deps: Deps,
  input: {
    groupId: number;
    challenger: User;
    message: Message;
    botUsername: string;
    useReplyTarget: boolean;
  },
): Promise<OpponentChoice> {
  const { challenger, message } = input;
  const mention = message.entities?.find(
    (entity) => entity.type === 'mention' || entity.type === 'text_mention',
  );
  if (mention?.type === 'text_mention') {
    // Picked from the mention list: Telegram hands over the person, username or not.
    if (mention.user.is_bot) return { kind: 'refuse', key: 'reply.bot' };
    if (mention.user.id === challenger.id) return { kind: 'refuse', key: 'reply.self' };
    return memberChoice(deps, input.groupId, mention.user);
  }
  if (mention) {
    const handle = (message.text ?? '')
      .slice(mention.offset + 1, mention.offset + mention.length)
      .toLowerCase();
    // Every bot username ends in "bot", so the suffix needs no lookup.
    if (handle === input.botUsername.toLowerCase() || handle.endsWith('bot'))
      return { kind: 'refuse', key: 'reply.bot' };
    if (handle === challenger.username?.toLowerCase()) return { kind: 'refuse', key: 'reply.self' };
    const opponent = await findMemberByUsername(deps.db, input.groupId, handle);
    if (opponent?.telegramUserId === challenger.id) return { kind: 'refuse', key: 'reply.self' };
    return opponent
      ? { kind: 'user', userId: opponent.id }
      : { kind: 'username', username: handle };
  }
  const target = message.reply_to_message;
  // In a forum topic, a message that replies to nothing carries the topic's opening message.
  if (!input.useReplyTarget || !target || target.forum_topic_created) return { kind: 'none' };
  if (target.sender_chat || !target.from) return { kind: 'refuse', key: 'reply.anonymous' };
  if (target.from.is_bot) return { kind: 'refuse', key: 'reply.bot' };
  if (target.from.id === challenger.id) return { kind: 'refuse', key: 'reply.self' };
  return memberChoice(deps, input.groupId, target.from);
}
