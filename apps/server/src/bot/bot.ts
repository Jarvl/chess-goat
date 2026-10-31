import { decodeCallbackData, t, type MessageKey, type MessageParams } from '@chess-goat/shared';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type Context } from 'grammy';
import type { Chat } from 'grammy/types';
import type { Config } from '../config';
import {
  acceptChallenge,
  cancelChallenge,
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
import { markLeft, touchMember } from '../domain/members';
import { ensureUser, setDmAllowed } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { createTelegramApi } from '../telegram/client';
import { miniAppLink } from '../telegram/links';
import { sendEphemeral } from './ephemeral';
import { resolveOpponent } from './opponent';
import { registerPayments } from './payments';
import {
  cardThread,
  challengeOrExplain,
  ephemeralIdOf,
  handlePromptTap,
  openPrompt,
  registerPromptReplies,
  sayPrivately,
  threadOf,
  type Answer,
} from './promptHandlers';
import { RateLimiter } from './rateLimit';
import { alertFor } from './replies';
import { userInfo } from './userInfo';

type GroupChat = Chat.GroupChat | Chat.SupergroupChat;

const chatInfo = (chat: GroupChat): TelegramChatInfo => ({
  telegramChatId: chat.id,
  title: chat.title,
  type: chat.type,
  isForum: chat.type === 'supergroup' && chat.is_forum === true,
});

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
  // Pre-checkout answers and private (ephemeral) answers get their own client without the message
  // throttler: bot.api's queue is shared with the job worker's sends, and a backlog there could
  // push an answer past Telegram's deadline (10 s for pre-checkout, 15 s for an ephemeral answer).
  const directApi = createTelegramApi(config, {
    apiRoot: config.TELEGRAM_API_ROOT,
    throttle: false,
  });

  const sendLine = (
    chatId: number,
    threadId: number | null,
    key: MessageKey,
    params: MessageParams,
    extra: { buttons?: { text: string; url: string }[] } = {},
  ) =>
    enqueue(deps.db, {
      kind: 'send_message',
      payload: { chatId, threadId, text: t(key, params), ...extra },
    });

  const groupOnly = bot.chatType(['group', 'supergroup']);

  // /challenge is a normal command: an ephemeral one arrives without the message it replies to.
  groupOnly.command('challenge', async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot || ctx.msg.sender_chat) return;
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    const user = await ensureUser(deps.db, userInfo(from));
    await touchMember(deps.db, group.id, user.id);
    const threadId = threadOf(ctx.msg);
    const answer: Answer = {
      chatId: ctx.chat.id,
      threadId,
      receiverId: from.id,
      // Only an admin bot may answer a normal message privately.
      trigger: group.botIsAdmin ? { kind: 'none' } : null,
      replyToMessageId: ctx.msg.message_id,
    };
    const choice = await resolveOpponent(deps, {
      groupId: group.id,
      challenger: from,
      message: ctx.msg,
      botUsername: ctx.me.username,
      useReplyTarget: true,
    });
    if (choice.kind === 'none') {
      await openPrompt(deps, directApi, { group, user, from, chatId: ctx.chat.id, threadId });
    } else if (choice.kind === 'refuse') {
      await sayPrivately(directApi, answer, choice.key);
    } else {
      const settings = settingsOf(group);
      await challengeOrExplain(deps, directApi, answer, {
        groupId: group.id,
        challengerId: user.id,
        opponentId: choice.kind === 'user' ? choice.userId : null,
        opponentUsername: choice.kind === 'username' ? choice.username : null,
        timePerMove: 259200,
        colour: 'random',
        rated: settings.ratedDefault,
        threadId: cardThread(settings, threadId),
      });
    }
    // Keeps the chat free of command chatter where the bot may delete; failing that, it stays.
    if (group.botIsAdmin) {
      await directApi.deleteMessage(ctx.chat.id, ctx.msg.message_id).catch((error: unknown) => {
        deps.log.debug({ err: error }, 'could not delete a /challenge command');
      });
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
      const threadId = threadOf(ctx.msg);
      const groupId = group.publicId;
      const key = kind === 'lobby' ? 'command.chess' : 'command.settings';
      const buttons =
        kind === 'lobby'
          ? [
              {
                text: t('button.challenge'),
                url: miniAppLink(config, { kind: 'newGame', groupId }),
              },
              { text: t('button.group_lobby'), url: miniAppLink(config, { kind, groupId }) },
            ]
          : [{ text: t('button.open_settings'), url: miniAppLink(config, { kind, groupId }) }];
      // An ephemeral command gets a private answer; an anonymous sender has nobody to receive one.
      const ephemeralMessageId = ephemeralIdOf(ctx.msg);
      if (
        !anonymous &&
        ephemeralMessageId !== null &&
        (await sendEphemeral(directApi, {
          chatId: ctx.chat.id,
          threadId,
          receiverId: ctx.from.id,
          trigger: { ephemeralMessageId },
          text: t(key),
          replyMarkup: { inline_keyboard: buttons.map((button) => [button]) },
        }))
      )
        return;
      await sendLine(ctx.chat.id, threadId, key, {}, { buttons });
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
    if (data.action === 'prompt') return handlePromptTap(deps, directApi, ctx.callbackQuery, data);
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

  // After the commands, so a command sent as a reply to the prompt stays a command.
  registerPromptReplies(groupOnly, deps, directApi);

  bot.chatType('private').on('message:write_access_allowed', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
  });

  registerPayments(bot, deps, directApi);

  return bot;
}
