import {
  analysisUrl,
  ratingLabel,
  isProvisional,
  sideToMove,
  type TimePerMove,
} from '@chess-goat/shared';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import type { ChallengeRow, GameRow, GroupRow, UserRow } from '../db/schema';
import { listMoves } from '../domain/games';
import { getPlayerRating } from '../domain/ratings';
import { displayName, flairEmoji, isOwnedBot, requireUser } from '../domain/users';
import type { ChallengeCardView, GameCardView, PersonView } from './cards';
import { label } from './cards';
import { miniAppLink } from './links';

export function personView(user: UserRow): PersonView {
  return {
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    telegramUserId: user.deletedAt ? null : user.telegramUserId,
    flair: flairEmoji(user),
  };
}

/** Cards name their group by its row, which every caller has already loaded to find the chat. */
type CardGroup = Pick<GroupRow, 'publicId'>;

function botChallenge(config: Config, group: CardGroup, bot: UserRow) {
  return {
    name: label(personView(bot)),
    link: miniAppLink(config, { kind: 'challengeBot', groupId: group.publicId, botId: bot.id }),
  };
}

function lobbyLink(config: Config, group: CardGroup): string {
  return miniAppLink(config, { kind: 'lobby', groupId: group.publicId });
}

export async function challengeCardView(
  tx: DbOrTx,
  challenge: ChallengeRow,
  group: CardGroup,
  config: Config,
): Promise<ChallengeCardView> {
  const challenger = await requireUser(tx, challenge.challengerId);
  const opponent =
    challenge.opponentId === null ? null : await requireUser(tx, challenge.opponentId);
  return {
    publicId: challenge.publicId,
    status: challenge.status,
    challenger: personView(challenger),
    opponent: opponent
      ? personView(opponent)
      : challenge.opponentUsername
        ? {
            name: `@${challenge.opponentUsername}`,
            username: challenge.opponentUsername,
            telegramUserId: null,
            flair: '',
          }
        : null,
    opponentIsBot: opponent !== null && isOwnedBot(opponent),
    opponentActivity:
      opponent !== null && isOwnedBot(opponent) ? { lastActiveAt: opponent.lastActiveAt } : null,
    timePerMove: challenge.timePerMove as TimePerMove,
    rated: challenge.rated,
    challengerColour: challenge.challengerColour,
    lobbyLink: lobbyLink(config, group),
    botChallenge: opponent && isOwnedBot(opponent) ? botChallenge(config, group, opponent) : null,
  };
}

async function ratingView(
  tx: DbOrTx,
  game: GameRow,
  userId: number,
  before: number | null,
  after: number | null,
  rdBefore: number | null,
  rdAfter: number | null,
): Promise<{ before: string; after: string | null } | null> {
  if (!game.rated) return null;
  if (
    game.status === 'finished' &&
    before !== null &&
    after !== null &&
    rdBefore !== null &&
    rdAfter !== null
  ) {
    return {
      before: ratingLabel(before, isProvisional(rdBefore)),
      after: ratingLabel(after, isProvisional(rdAfter)),
    };
  }
  const current = await getPlayerRating(tx, game.groupId, userId);
  return {
    before: ratingLabel(current?.rating ?? 1500, isProvisional(current?.rd ?? 350)),
    after: null,
  };
}

export async function gameCardView(
  tx: DbOrTx,
  game: GameRow,
  group: CardGroup,
  config: Config,
): Promise<GameCardView> {
  const [white, black] = await Promise.all([
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
  ]);
  // Bot-vs-bot games have no card, so a card has at most one bot side.
  const botSide = isOwnedBot(white) ? 'white' : isOwnedBot(black) ? 'black' : null;
  const bot = botSide === 'white' ? white : botSide === 'black' ? black : null;
  const moves = game.status === 'finished' && game.plyCount > 0 ? await listMoves(tx, game.id) : [];
  return {
    publicId: game.publicId,
    status: game.status,
    white: personView(white),
    black: personView(black),
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    plyCount: game.plyCount,
    sideToMove: sideToMove(game.fen),
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
    whiteRating: await ratingView(
      tx,
      game,
      game.whiteId,
      game.whiteRatingBefore,
      game.whiteRatingAfter,
      game.whiteRdBefore,
      game.whiteRdAfter,
    ),
    blackRating: await ratingView(
      tx,
      game,
      game.blackId,
      game.blackRatingBefore,
      game.blackRatingAfter,
      game.blackRdBefore,
      game.blackRdAfter,
    ),
    abortedBy: null,
    analysisUrl: moves.length > 0 ? analysisUrl(moves.map((move) => move.san)) : null,
    lichessUrl: game.lichessUrl,
    openLink: miniAppLink(config, { kind: 'game', gameId: game.publicId }),
    lobbyLink: lobbyLink(config, group),
    botChallenge: bot ? botChallenge(config, group, bot) : null,
    botActivity: bot && botSide ? { side: botSide, lastActiveAt: bot.lastActiveAt } : null,
  };
}
