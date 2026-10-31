import {
  decodeCallbackData,
  t,
  type GroupSettings,
  type MessageKey,
  type MessageParams,
} from '@chess-goat/shared';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type Context } from 'grammy';
import type { Chat } from 'grammy/types';
import type { Config } from '../config';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  getChallengeByPublicId,
} from '../domain/challenges';
import type { Deps } from '../domain/deps';
import { DomainError } from '../domain/errors';
import { requireGameByPublicId } from '../domain/games';
import { cancelPendingChallengesForGroup } from '../domain/groupLifecycle';
import {
  ensureGroup,
  getGroupByChatId,
  migrateChatId,
  setBotMembership,
  settingsOf,
  type TelegramChatInfo,
} from '../domain/groups';
import { findMemberByUsername, markLeft, touchMember } from '../domain/members';
import { ensureUser, setDmAllowed } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { createTelegramApi } from '../telegram/client';
import { miniAppLink } from '../telegram/links';
import { RateLimiter } from './rateLimit';
import { registerPayments } from './payments';
import { alertFor, replyFor } from './replies';
import { userInfo } from './userInfo';

type GroupChat = Chat.GroupChat | Chat.SupergroupChat;

const chatInfo = (chat: GroupChat): TelegramChatInfo => ({
  telegramChatId: chat.id,
  title: chat.title,
  type: chat.type,
  isForum: chat.type === 'supergroup' && chat.is_forum === true,
});

/** Cards go to the topic the challenge was made in, or to the configured fixed topic (spec §5.8). */
function cardThread(settings: GroupSettings, originThread: number | null): number | null {
  return settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : originThread;
}

function isGroupChat(chat: Chat): chat is GroupChat {
  return chat.type === 'group' || chat.type === 'supergroup';
}

export async function createBot(deps: Deps, config: Config): Promise<Bot> {
  const bot = new Bot(
    config.BOT_TOKEN,
    config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : {},
  );
  bot.api.config.use(apiThrottler());
  await bot.init();
  const linkLimiter = new RateLimiter(20, 60_000);
  // Pre-checkout answers get their own client without the message throttler: bot.api's queue is
  // shared with the job worker's sends, and a backlog there could push the answer past
  // Telegram's 10-second pre-checkout deadline.
  const checkoutApi = createTelegramApi(config, {
    apiRoot: config.TELEGRAM_API_ROOT,
    throttle: false,
  });

  const sendLine = (
    chatId: number,
    threadId: number | null,
    key: MessageKey,
    params: MessageParams,
    extra: { replyToMessageId?: number; buttons?: { text: string; url: string }[] } = {},
  ) =>
    enqueue(deps.db, {
      kind: 'send_message',
      payload: { chatId, threadId, text: t(key, params), ...extra },
    });

  const groupOnly = bot.chatType(['group', 'supergroup']);

  groupOnly.command('challenge', async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot || ctx.msg.sender_chat) return;
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    const user = await ensureUser(deps.db, userInfo(from));
    await touchMember(deps.db, group.id, user.id);
    const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
    const reply = (key: MessageKey, params: MessageParams = {}) =>
      sendLine(ctx.chat.id, threadId, key, params, { replyToMessageId: ctx.msg.message_id });
    // An @mention names the opponent more deliberately than the message the command replies to.
    const mention = ctx.msg.entities?.find(
      (entity) => entity.type === 'mention' || entity.type === 'text_mention',
    );
    const target = ctx.msg.reply_to_message;
    let opponentId: number | null = null;
    if (mention?.type === 'text_mention') {
      // Picked from the mention list: Telegram hands over the person, username or not.
      if (mention.user.is_bot) return reply('reply.bot');
      if (mention.user.id === from.id) return reply('reply.self');
      const opponent = await ensureUser(deps.db, userInfo(mention.user));
      await touchMember(deps.db, group.id, opponent.id);
      opponentId = opponent.id;
    } else if (mention) {
      const handle = (ctx.msg.text ?? '').slice(
        mention.offset + 1,
        mention.offset + mention.length,
      );
      if (handle.toLowerCase() === ctx.me.username.toLowerCase()) return reply('reply.bot');
      const opponent = await findMemberByUsername(deps.db, group.id, handle);
      if (opponent?.id === user.id) return reply('reply.self');
      if (!opponent) return reply('reply.unknown_mention', { name: `@${handle}` });
      opponentId = opponent.id;
    } else if (target) {
      if (target.sender_chat || !target.from) return reply('reply.anonymous');
      if (target.from.is_bot) return reply('reply.bot');
      if (target.from.id === from.id) return reply('reply.self');
      const opponent = await ensureUser(deps.db, userInfo(target.from));
      await touchMember(deps.db, group.id, opponent.id);
      opponentId = opponent.id;
    }
    const settings = settingsOf(group);
    try {
      await createChallenge(deps, {
        groupId: group.id,
        challengerId: user.id,
        opponentId,
        timePerMove: settings.defaultTimePerMove,
        colour: 'random',
        rated: settings.ratedDefault,
        threadId: cardThread(settings, threadId),
      });
    } catch (error) {
      const line = replyFor(error);
      if (!line) throw error;
      await reply(line.key, line.params);
    }
  });

  const linkCommand =
    (kind: 'lobby' | 'settings') =>
    async (ctx: Context & { chat: GroupChat; msg: NonNullable<Context['msg']> }) => {
      // Anonymous admins and people posting as a channel arrive from a bot account with
      // sender_chat set. The link needs nobody's identity, so they get it too.
      const anonymous = ctx.msg.sender_chat !== undefined;
      if (!ctx.from || (ctx.from.is_bot && !anonymous) || ctx.msg.is_automatic_forward) return;
      // /chess and /settings share 20 links per person per group per minute (spec §7.8); anonymous
      // senders share one budget per chat they post as.
      const sender = ctx.msg.sender_chat?.id ?? ctx.from.id;
      if (!linkLimiter.allow(`link:${ctx.chat.id}:${sender}`)) return;
      const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
      if (!anonymous) {
        const user = await ensureUser(deps.db, userInfo(ctx.from));
        await touchMember(deps.db, group.id, user.id);
      }
      const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
      const groupId = group.publicId;
      await sendLine(
        ctx.chat.id,
        threadId,
        kind === 'lobby' ? 'command.chess' : 'command.settings',
        {},
        {
          buttons:
            kind === 'lobby'
              ? [
                  {
                    text: t('button.challenge'),
                    url: miniAppLink(config, { kind: 'newGame', groupId }),
                  },
                  { text: t('button.group_lobby'), url: miniAppLink(config, { kind, groupId }) },
                ]
              : [{ text: t('button.open_settings'), url: miniAppLink(config, { kind, groupId }) }],
        },
      );
    };
  groupOnly.command('chess', linkCommand('lobby'));
  groupOnly.command('settings', linkCommand('settings'));

  bot.chatType('private').command('start', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
    await sendLine(
      ctx.chat.id,
      null,
      'dm.start',
      {},
      {
        buttons: [{ text: t('button.open_chess'), url: miniAppLink(config) }],
      },
    );
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) return ctx.answerCallbackQuery();
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    const chat = ctx.callbackQuery.message?.chat;
    if (chat && isGroupChat(chat)) {
      const group = await getGroupByChatId(deps.db, chat.id);
      if (group) await touchMember(deps.db, group.id, user.id);
    }
    try {
      if (data.action === 'rematch') {
        const game = await requireGameByPublicId(deps.db, data.gameId);
        await createRematch(deps, { gameId: game.id, userId: user.id });
      } else {
        const challenge = await getChallengeByPublicId(deps.db, data.challengeId);
        if (!challenge) throw new DomainError('not_found', 'challenge not found');
        if (data.action === 'accept_challenge') {
          await acceptChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else if (challenge.challengerId === user.id) {
          await cancelChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else {
          await declineChallenge(deps, { challengeId: challenge.id, userId: user.id });
        }
      }
      await ctx.answerCallbackQuery();
    } catch (error) {
      const text = await alertFor(deps, error, data.action);
      if (text === null) throw error;
      await ctx.answerCallbackQuery({ text, show_alert: true });
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const status = update.new_chat_member.status;
    if (update.chat.type === 'private') {
      const user = await ensureUser(deps.db, userInfo(update.from));
      await setDmAllowed(deps.db, user.id, status === 'member');
      return;
    }
    if (!isGroupChat(update.chat)) return;
    const group = await ensureGroup(deps.db, chatInfo(update.chat));
    if (status === 'member' || status === 'administrator') {
      const member = update.new_chat_member;
      const canPin = member.status === 'administrator' && member.can_pin_messages === true;
      await setBotMembership(deps.db, group.id, {
        botStatus: status,
        botIsAdmin: status === 'administrator',
        botCanPin: canPin,
      });
      if (!update.from.is_bot) {
        const adder = await ensureUser(deps.db, userInfo(update.from));
        await touchMember(deps.db, group.id, adder.id);
      }
      const old = update.old_chat_member.status;
      if (old === 'left' || old === 'kicked') {
        await enqueue(deps.db, {
          kind: 'send_welcome',
          payload: { groupId: group.id },
          dedupKey: `welcome:${group.publicId}`,
        });
      }
    } else if (status === 'left' || status === 'kicked') {
      await setBotMembership(deps.db, group.id, {
        botStatus: 'left',
        botIsAdmin: false,
        botCanPin: false,
      });
      await cancelPendingChallengesForGroup(deps, group.id);
    }
  });

  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (!isGroupChat(update.chat)) return;
    const group = await getGroupByChatId(deps.db, update.chat.id);
    const target = update.new_chat_member.user;
    if (!group || target.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(target));
    const member = update.new_chat_member;
    const present =
      member.status === 'member' ||
      member.status === 'administrator' ||
      member.status === 'creator' ||
      (member.status === 'restricted' && member.is_member);
    if (present) await touchMember(deps.db, group.id, user.id, { verified: true });
    else await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:new_chat_members', async (ctx) => {
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    for (const joined of ctx.msg.new_chat_members) {
      if (joined.is_bot) continue;
      const user = await ensureUser(deps.db, userInfo(joined));
      await touchMember(deps.db, group.id, user.id);
    }
  });

  groupOnly.on('message:left_chat_member', async (ctx) => {
    const left = ctx.msg.left_chat_member;
    const group = await getGroupByChatId(deps.db, ctx.chat.id);
    if (!group || left.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(left));
    await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:migrate_to_chat_id', async (ctx) => {
    await migrateChatId(deps.db, ctx.chat.id, ctx.msg.migrate_to_chat_id);
  });

  bot.chatType('private').on('message:write_access_allowed', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
  });

  registerPayments(bot, deps, checkoutApi);

  return bot;
}
