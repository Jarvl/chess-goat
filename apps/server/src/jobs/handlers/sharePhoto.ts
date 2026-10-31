import {
  analysisUrl,
  INITIAL_FEN,
  isProvisional,
  ratingLabel,
  t,
  type Colour,
} from '@chess-goat/shared';
import { Chess } from 'chess.js';
import { and, eq, isNull } from 'drizzle-orm';
import { InputFile } from 'grammy';
import type { InlineKeyboardButton, Message } from 'grammy/types';
import { z } from 'zod';
import {
  games,
  jobs,
  shares,
  type GameRow,
  type GroupRow,
  type MoveRow,
  type UserRow,
} from '../../db/schema';
import { flairAwardDedupKey, listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { getPhotoBytes } from '../../domain/photos';
import { getPlayerRating } from '../../domain/ratings';
import { displayName, nameWithFlair, requireUser } from '../../domain/users';
import { getCachedFileId, snapshotImageKey, storeFileId } from '../../images/cache';
import type { SnapshotFonts } from '../../images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../images/snapshot';
import { buildSnapshotModel, shareMoveNumber, type SnapshotSide } from '../../images/snapshotModel';
import {
  MAX_BUTTON_URL_LENGTH,
  renderResultCaption,
  renderShareCaption,
  type RatingChange,
} from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type CallResult, type TelegramHandlerContext } from './telegramCall';

const sharePayloadSchema = z.object({ shareId: z.number().int() });
const resultPayloadSchema = z.object({ gameId: z.number().int() });

/** The position after `ply` (0 = the initial position) and the move that produced it. */
export function positionAtPly(
  moves: Pick<MoveRow, 'ply' | 'uci' | 'fenAfter'>[],
  ply: number,
): { fen: string; lastMove: string | null } {
  if (ply === 0) return { fen: INITIAL_FEN, lastMove: null };
  const move = moves.find((row) => row.ply === ply);
  if (!move) throw new Error(`no move at ply ${ply}`);
  return { fen: move.fenAfter, lastMove: move.uci };
}

type SideRatings = { before: number; after: number; rdBefore: number; rdAfter: number };

/** One side's rating before and after a rated game; null until its snapshots were all written. */
function sideRatings(game: GameRow, colour: Colour): SideRatings | null {
  if (!game.rated) return null;
  const [before, after, rdBefore, rdAfter] =
    colour === 'white'
      ? [game.whiteRatingBefore, game.whiteRatingAfter, game.whiteRdBefore, game.whiteRdAfter]
      : [game.blackRatingBefore, game.blackRatingAfter, game.blackRdBefore, game.blackRdAfter];
  if (before === null || after === null || rdBefore === null || rdAfter === null) return null;
  return { before, after, rdBefore, rdAfter };
}

async function side(
  ctx: TelegramHandlerContext,
  game: GameRow,
  user: UserRow,
  colour: Colour,
): Promise<SnapshotSide> {
  return {
    id: String(user.id),
    name: displayName(user),
    isBot: user.isEngine,
    rating: await getPlayerRating(ctx.deps.db, game.groupId, user.id),
    engineLevel: user.isEngine ? game.engineLevel : null,
    ratingChange: sideRatings(game, colour),
    photo:
      user.photoHash && !user.isEngine ? await getPhotoBytes(ctx.deps.db, user.photoHash) : null,
    flair: user.flairWorn,
  };
}

/**
 * Snapshot spec §3.1: build the card for `ply`, reuse or upload it, and post it to the game's topic.
 * Shares and result photos both come through here, so the same position renders the same image.
 */
async function postSnapshot(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
  input: {
    game: GameRow;
    group: GroupRow;
    white: UserRow;
    black: UserRow;
    moves: MoveRow[];
    ply: number;
    orientation: 'white' | 'black';
    caption: string;
    buttons: InlineKeyboardButton[][];
  },
): Promise<CallResult<Message.PhotoMessage>> {
  const { game, group, ply } = input;
  const position = positionAtPly(input.moves, ply);
  const model = buildSnapshotModel({
    ply,
    board: {
      ...position,
      check: new Chess(position.fen).inCheck(),
      orientation: input.orientation,
    },
    white: await side(ctx, game, input.white, 'white'),
    black: await side(ctx, game, input.black, 'black'),
    status: game.status,
    result: game.result,
    plyCount: game.plyCount,
    voided: game.voidedAt !== null,
    botUsername: ctx.config.BOT_USERNAME,
  });
  const svg = await renderSnapshotSvg(model, fonts);
  const key = snapshotImageKey(svg);
  const cached = await getCachedFileId(ctx.deps.db, key);
  const photo = cached ?? new InputFile(renderSnapshotPng(svg), 'snapshot.png');
  const result = await call(ctx, group.telegramChatId, () =>
    ctx.api.sendPhoto(group.telegramChatId, photo, {
      caption: input.caption,
      message_thread_id: game.cardThreadId ?? undefined,
      reply_markup: { inline_keyboard: input.buttons },
    }),
  );
  const largest = result.ok ? result.value.photo.at(-1) : undefined;
  if (!cached && largest) await storeFileId(ctx.deps.db, key, largest.file_id);
  return result;
}

async function players(ctx: TelegramHandlerContext, game: GameRow) {
  const [white, black, moves] = await Promise.all([
    requireUser(ctx.deps.db, game.whiteId),
    requireUser(ctx.deps.db, game.blackId),
    listMoves(ctx.deps.db, game.id),
  ]);
  return { white, black, moves };
}

const sendSharePhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { shareId } = sharePayloadSchema.parse(job.payload);
    const [share] = await ctx.deps.db.select().from(shares).where(eq(shares.id, shareId));
    if (!share || share.messageId !== null) return { outcome: 'done' };
    const game = await requireGameById(ctx.deps.db, share.gameId);
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const [sharer, { white, black, moves }] = await Promise.all([
      requireUser(ctx.deps.db, share.userId),
      players(ctx, game),
    ]);
    const result = await postSnapshot(ctx, fonts, {
      game,
      group,
      white,
      black,
      moves,
      ply: share.ply,
      orientation: share.userId === game.blackId ? 'black' : 'white',
      caption: renderShareCaption({
        sharer: nameWithFlair(sharer),
        moveNumber: shareMoveNumber(share.ply),
        white: nameWithFlair(white),
        black: nameWithFlair(black),
      }),
      buttons: [
        [
          {
            text: t('button.open_live_game'),
            url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
          },
        ],
        [
          {
            text: t('button.group_lobby'),
            url: miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
          },
        ],
      ],
    });
    if (!result.ok) return settle(result);
    await ctx.deps.db
      .update(shares)
      .set({ messageId: result.value.message_id })
      .where(eq(shares.id, share.id));
    return { outcome: 'done' };
  };

/** Both sides' rating change, only for a rated game whose snapshots were all written. */
function ratingChanges(game: GameRow): { white: RatingChange; black: RatingChange } | null {
  const change = (ratings: SideRatings | null): RatingChange | null =>
    ratings && {
      before: ratingLabel(ratings.before, isProvisional(ratings.rdBefore)),
      after: ratingLabel(ratings.after, isProvisional(ratings.rdAfter)),
    };
  const white = change(sideRatings(game, 'white'));
  const black = change(sideRatings(game, 'black'));
  return white && black ? { white, black } : null;
}

/** How long the result photo waits before looking again for the game's flair award to finish. */
const FLAIR_AWARD_WAIT_MS = 2_000;

/**
 * Whether the game's `award_flair` job has yet to run. A failed award is done too, so a rule that
 * throws never holds back the photo.
 */
async function flairAwardPending(ctx: TelegramHandlerContext, game: GameRow): Promise<boolean> {
  const [pending] = await ctx.deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupKey, flairAwardDedupKey(game.publicId)), isNull(jobs.doneAt)));
  return pending !== undefined;
}

/** The finished game's final position, told to its group (the players get no game-end DM). */
const sendResultPhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { gameId } = resultPayloadSchema.parse(job.payload);
    const game = await requireGameById(ctx.deps.db, gameId);
    if (game.status !== 'finished' || game.resultMessageId !== null) return { outcome: 'done' };
    if (!game.result || !game.endReason) return { outcome: 'done' };
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    // The award is queued with this photo when the game ends; waiting for it lets the photo show
    // the flair this game earned.
    if (await flairAwardPending(ctx, game))
      return { outcome: 'retry', delayMs: FLAIR_AWARD_WAIT_MS };
    const { white, black, moves } = await players(ctx, game);
    const analysis =
      game.lichessUrl ?? (moves.length > 0 ? analysisUrl(moves.map((move) => move.san)) : null);
    const buttons: InlineKeyboardButton[][] = [
      [
        {
          text: t('button.open_game'),
          url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
        },
      ],
    ];
    if (analysis && analysis.length <= MAX_BUTTON_URL_LENGTH)
      buttons.push([{ text: t('button.analyse'), url: analysis }]);
    const result = await postSnapshot(ctx, fonts, {
      game,
      group,
      white,
      black,
      moves,
      ply: game.plyCount,
      // The winner's view of their win; a draw or a void is shown from White's side.
      orientation: game.result === '0-1' ? 'black' : 'white',
      caption: renderResultCaption({
        white: nameWithFlair(white),
        black: nameWithFlair(black),
        result: game.result,
        endReason: game.endReason,
        ratings: ratingChanges(game),
      }),
      buttons,
    });
    if (!result.ok) return settle(result);
    await ctx.deps.db
      .update(games)
      .set({ resultMessageId: result.value.message_id })
      .where(eq(games.id, game.id));
    return { outcome: 'done' };
  };

export function sharePhotoJobHandlers(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
): JobHandlers {
  return {
    send_share_photo: sendSharePhoto(ctx, fonts),
    send_result_photo: sendResultPhoto(ctx, fonts),
  };
}
