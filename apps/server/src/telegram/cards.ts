import {
  encodeCallbackData,
  endReasonLabel,
  movesLabel,
  ratedLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  timeSpanLabel,
  type ChallengeStatus,
  type Colour,
  type ColourChoice,
  type EndReason,
  type GameResult,
  type GameStatus,
  type MessageKey,
  type MessageParams,
  type TimePerMove,
  type TimePerMoveSeconds,
} from '@chess-goat/shared';
import type { InlineKeyboardButton, InlineKeyboardMarkup, MessageEntity } from 'grammy/types';

export const MAX_BUTTON_URL_LENGTH = 2000;

export type PersonView = {
  name: string;
  username: string | null;
  telegramUserId: number | null;
  /** Worn flair's emoji run together (`👑🚶`), `''` when none: shown after the name everywhere. */
  flair: string;
};

export type RenderedMessage = {
  text: string;
  entities: MessageEntity[];
  reply_markup?: InlineKeyboardMarkup;
};

export type ChallengeCardView = {
  publicId: string;
  status: ChallengeStatus;
  challenger: PersonView;
  opponent: PersonView | null;
  timePerMove: TimePerMove;
  rated: boolean;
  challengerColour: ColourChoice;
  lobbyLink: string;
};

export type GameCardView = {
  publicId: string;
  status: GameStatus;
  white: PersonView;
  black: PersonView;
  timePerMove: TimePerMove;
  rated: boolean;
  plyCount: number;
  sideToMove: Colour;
  result: GameResult | null;
  endReason: EndReason | null;
  voided: boolean;
  /** Rating labels (`1520`, `1498?`); null for casual games. */
  whiteRating: { before: string; after: string | null } | null;
  blackRating: { before: string; after: string | null } | null;
  abortedBy: PersonView | null;
  analysisUrl: string | null;
  lichessUrl: string | null;
  openLink: string;
  lobbyLink: string;
};

const MENTION_MARK = '\u0000';

/** A person as the cards name them: the name, then their worn flair (flair beside names). */
function label(person: PersonView): string {
  return person.flair ? `${person.name} ${person.flair}` : person.name;
}

/**
 * Renders a template whose `{opponent}` slot is a mention: `@username`, else a text_mention entity
 * (spec §5.4). Flair follows the mention, outside the entity, which covers only the name.
 */
function withMention(
  key: MessageKey,
  params: MessageParams,
  slot: string,
  person: PersonView,
): { text: string; entities: MessageEntity[] } {
  const rendered = t(key, { ...params, [slot]: MENTION_MARK });
  const offset = rendered.indexOf(MENTION_MARK);
  const flair = person.flair ? ` ${person.flair}` : '';
  if (person.username) {
    return { text: rendered.replace(MENTION_MARK, `@${person.username}${flair}`), entities: [] };
  }
  const text = rendered.replace(MENTION_MARK, `${person.name}${flair}`);
  if (person.telegramUserId === null) return { text, entities: [] };
  return {
    text,
    entities: [
      {
        type: 'text_mention',
        offset,
        length: person.name.length,
        user: { id: person.telegramUserId, first_name: person.name, is_bot: false },
      },
    ],
  };
}

function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup | undefined {
  const nonEmpty = rows.filter((row) => row.length > 0);
  return nonEmpty.length > 0 ? { inline_keyboard: nonEmpty } : undefined;
}

/** The last row of every group card: the way into the group's page without knowing /chess. */
function lobbyRow(view: { lobbyLink: string }): InlineKeyboardButton[] {
  return [{ text: t('button.group_lobby'), url: view.lobbyLink }];
}

function urlButton(text: string, url: string | null): InlineKeyboardButton | null {
  if (!url || url.length > MAX_BUTTON_URL_LENGTH) return null;
  return { text, url };
}

function terms(view: ChallengeCardView): string {
  const base = { timePerMove: timePerMoveLabel(view.timePerMove), rated: ratedLabel(view.rated) };
  if (view.challengerColour === 'random') return t('card.challenge.terms', base);
  return t('card.challenge.terms_colour', {
    ...base,
    challenger: label(view.challenger),
    colour: t(`colour.${view.challengerColour}`),
  });
}

export function renderChallengeCard(view: ChallengeCardView): RenderedMessage {
  const challenger = label(view.challenger);
  if (view.status === 'pending') {
    const line1 = view.opponent
      ? withMention('card.challenge.direct', { challenger }, 'opponent', view.opponent)
      : { text: t('card.challenge.open', { challenger }), entities: [] };
    const accept = {
      text: t('button.accept'),
      callback_data: encodeCallbackData({ action: 'accept_challenge', challengeId: view.publicId }),
    };
    const declineOrCancel = {
      text: t(view.opponent ? 'button.decline' : 'button.cancel'),
      callback_data: encodeCallbackData({
        action: 'decline_challenge',
        challengeId: view.publicId,
      }),
    };
    return {
      text: `${line1.text}\n${terms(view)}`,
      entities: line1.entities,
      reply_markup: keyboard([[accept, declineOrCancel], lobbyRow(view)]),
    };
  }
  const params = { challenger, opponent: view.opponent ? label(view.opponent) : '' };
  const key: MessageKey = view.opponent
    ? view.status === 'declined'
      ? 'card.challenge.declined'
      : view.status === 'expired'
        ? 'card.challenge.expired'
        : 'card.challenge.withdrawn'
    : view.status === 'expired'
      ? 'card.challenge.open_expired'
      : 'card.challenge.open_withdrawn';
  return { text: t(key, params), entities: [], reply_markup: keyboard([lobbyRow(view)]) };
}

export function renderGameCard(view: GameCardView): RenderedMessage {
  const white = label(view.white);
  const black = label(view.black);
  const rematch = {
    text: t('button.rematch'),
    callback_data: encodeCallbackData({ action: 'rematch', gameId: view.publicId }),
  };
  const analyse = urlButton(t('button.analyse'), view.lichessUrl ?? view.analysisUrl);

  if (view.voided) {
    const lines = [t('card.voided.title', { white, black })];
    if (view.result && view.result !== '*' && view.endReason && view.endReason !== 'voided') {
      lines.push(
        t('card.voided.status', {
          endReason: endReasonLabel(view.endReason),
          result: resultLabel(view.result),
        }),
      );
    }
    const buttons = view.plyCount > 0 && analyse ? [analyse] : [];
    return {
      text: lines.join('\n'),
      entities: [],
      reply_markup: keyboard([buttons, lobbyRow(view)]),
    };
  }

  if (view.status === 'active') {
    const title =
      view.rated && view.whiteRating && view.blackRating
        ? t('card.running.title', {
            white,
            black,
            whiteRating: view.whiteRating.before,
            blackRating: view.blackRating.before,
          })
        : t('card.running.title_casual', { white, black });
    const status = t('card.running.status', {
      timePerMove: timePerMoveLabel(view.timePerMove),
      rated: ratedLabel(view.rated),
      moveNumber: Math.floor(view.plyCount / 2) + 1,
      sideToMove: view.sideToMove === 'white' ? white : black,
    });
    return {
      text: `${title}\n${status}`,
      entities: [],
      reply_markup: keyboard([
        [{ text: t('button.open_game'), url: view.openLink }],
        lobbyRow(view),
      ]),
    };
  }

  if (view.endReason === 'abort' || view.endReason === 'timeout_abort') {
    const reason =
      view.endReason === 'timeout_abort' && view.timePerMove !== null
        ? t('card.aborted.no_move', { span: timeSpanLabel(view.timePerMove as TimePerMoveSeconds) })
        : view.abortedBy
          ? t('card.aborted.by_player', { name: label(view.abortedBy) })
          : null;
    const lines = [t('card.aborted.title', { white, black })];
    if (reason) lines.push(reason);
    return {
      text: lines.join('\n'),
      entities: [],
      reply_markup: keyboard([[rematch], lobbyRow(view)]),
    };
  }

  const title =
    view.rated && view.whiteRating && view.blackRating
      ? t('card.finished.title', {
          white,
          whiteBefore: view.whiteRating.before,
          whiteAfter: view.whiteRating.after ?? view.whiteRating.before,
          black,
          blackBefore: view.blackRating.before,
          blackAfter: view.blackRating.after ?? view.blackRating.before,
        })
      : t('card.finished.title_casual', { white, black });
  const status = t('card.finished.status', {
    endReason: view.endReason ? endReasonLabel(view.endReason) : '',
    result: view.result ? resultLabel(view.result) : '',
    moves: movesLabel(Math.ceil(view.plyCount / 2)),
    timePerMove: timePerMoveLabel(view.timePerMove),
  });
  const buttons = analyse ? [rematch, analyse] : [rematch];
  return {
    text: `${title}\n${status}`,
    entities: [],
    reply_markup: keyboard([buttons, lobbyRow(view)]),
  };
}

export function renderWelcomeCard(links: { challenge: string; lobby: string }): RenderedMessage {
  return {
    text: t('card.welcome'),
    entities: [],
    reply_markup: keyboard([
      [{ text: t('button.challenge'), url: links.challenge }],
      [{ text: t('button.group_lobby'), url: links.lobby }],
    ]),
  };
}

export function renderShareCaption(view: {
  sharer: string;
  moveNumber: number;
  white: string;
  black: string;
}): string {
  return t('card.share.caption', view);
}

/** A side's rating before and after the game, already worded. */
export type RatingChange = { before: string; after: string };

export function renderResultCaption(view: {
  white: string;
  black: string;
  result: GameResult;
  endReason: EndReason;
  ratings: { white: RatingChange; black: RatingChange } | null;
}): string {
  // A `*` result (a game voided while running) has no score worth naming, only the reason.
  const outcome =
    view.result === '*'
      ? endReasonLabel(view.endReason)
      : `${resultLabel(view.result)} · ${endReasonLabel(view.endReason)}`;
  const caption = t('card.result.caption', { white: view.white, black: view.black, outcome });
  if (!view.ratings) return caption;
  const ratings = t('card.result.ratings', {
    white: view.white,
    whiteBefore: view.ratings.white.before,
    whiteAfter: view.ratings.white.after,
    black: view.black,
    blackBefore: view.ratings.black.before,
    blackAfter: view.ratings.black.after,
  });
  return `${caption}\n${ratings}`;
}
