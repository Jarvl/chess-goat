import {
  ColourSchema,
  decodePremoveBytes,
  EndReasonSchema,
  GameResultSchema,
  GameStatusSchema,
  PlayerKindSchema,
  type Colour,
  type PremoveNode,
} from '@chess-goat/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { games, groups, users, type GameRow, type MoveRow, type UserRow } from '../db/schema';
import { DomainError } from './errors';
import { colourOf, storedPremoveTree } from './gameDto';
import { listMoves } from './games';
import { buildGamePgn } from './pgn';
import { kindOf } from './playerKind';
import { displayName } from './users';

/**
 * Bot View: a game as a bot's agent sees it, from the bot's side. The zod schemas here are the
 * source of truth: the MCP tools publish them as their output schemas, and the types are inferred
 * from them, so the two cannot drift.
 */

/** Another player, as a bot sees them: a name, and what kind of player they are. */
export const BotViewPersonSchema = z.object({ name: z.string(), kind: PlayerKindSchema });

export const DrawOfferSchema = z.enum(['none', 'from_you', 'from_opponent']);
export type DrawOffer = z.infer<typeof DrawOfferSchema>;

/** A standing draw offer, from the side of the player playing `you`. */
export function drawOfferFor(drawOfferBy: Colour | null, you: Colour): DrawOffer {
  if (drawOfferBy === null) return 'none';
  return drawOfferBy === you ? 'from_you' : 'from_opponent';
}

const PremoveNodeSchema: z.ZodType<PremoveNode> = z.lazy(() =>
  z.object({ move: z.string(), reply: z.string(), children: z.array(PremoveNodeSchema) }),
);

export const GameViewSchema = z.object({
  gameId: z.string(),
  group: z.object({ groupId: z.string(), title: z.string() }),
  you: ColourSchema,
  opponent: BotViewPersonSchema,
  status: GameStatusSchema,
  result: GameResultSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  ply: z.number().int(),
  toMove: ColourSchema,
  yourTurn: z.boolean(),
  fen: z.string(),
  board: z.string(),
  moves: z.array(z.string()),
  legalMoves: z.array(z.object({ san: z.string(), uci: z.string() })),
  timePerMove: z.number().nullable(),
  deadlineAt: z.string().nullable(),
  drawOffer: DrawOfferSchema,
  rated: z.boolean(),
  premoveTree: z.array(PremoveNodeSchema),
  pgn: z.string().optional(),
});

export type GameView = z.infer<typeof GameViewSchema>;

export type RenderInput = {
  game: GameRow;
  moves: readonly Pick<MoveRow, 'san'>[];
  group: { publicId: string; title: string };
  white: UserRow;
  black: UserRow;
};

/** The board as text from `orientation`'s side: rank labels down the left, files along the foot. */
export function asciiBoard(fen: string, orientation: Colour): string {
  const board = new Chess(fen).board();
  const ranks = orientation === 'white' ? board : [...board].reverse();
  const lines = ranks.map((rank, i) => {
    const row = orientation === 'white' ? rank : [...rank].reverse();
    const label = orientation === 'white' ? 8 - i : i + 1;
    const cells = row.map((sq) =>
      sq === null ? '.' : sq.color === 'w' ? sq.type.toUpperCase() : sq.type,
    );
    return `${label} ${cells.join(' ')}`;
  });
  const files = orientation === 'white' ? 'abcdefgh' : 'hgfedcba';
  lines.push(`  ${[...files].join(' ')}`);
  return lines.join('\n');
}

/** The game as `viewerBotId` sees it. The caller guarantees that bot plays in the game. */
export function renderGame(input: RenderInput, viewerBotId: number): GameView {
  const { game } = input;
  const you = colourOf(game, viewerBotId);
  if (you === null) throw new Error('renderGame: the viewer is not a player');
  const chess = new Chess(game.fen);
  const toMove: Colour = chess.turn() === 'w' ? 'white' : 'black';
  const active = game.status === 'active';
  const yourTurn = active && toMove === you;
  const opponent = you === 'white' ? input.black : input.white;
  return {
    gameId: game.publicId,
    group: { groupId: input.group.publicId, title: input.group.title },
    you,
    opponent: { name: displayName(opponent), kind: kindOf(opponent) },
    status: game.status,
    result: game.result,
    endReason: game.endReason,
    ply: game.plyCount,
    toMove,
    yourTurn,
    fen: game.fen,
    board: asciiBoard(game.fen, you),
    moves: input.moves.map((move) => move.san),
    legalMoves: yourTurn
      ? chess.moves({ verbose: true }).map((move) => ({ san: move.san, uci: move.lan }))
      : [],
    timePerMove: game.timePerMove,
    deadlineAt: active && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    drawOffer: drawOfferFor(active ? game.drawOfferBy : null, you),
    rated: game.rated,
    // The stored tree belongs to the side not to move, and only counts at the ply it was stored.
    premoveTree: active && toMove !== you ? decodePremoveBytes(storedPremoveTree(game)) : [],
  };
}

/** A game `bot` plays in. One that does not exist, or that the bot is not in, is `not_found`. */
export async function findBotGame(tx: DbOrTx, bot: UserRow, publicId: string): Promise<GameRow> {
  const [row] = await tx.select().from(games).where(eq(games.publicId, publicId)).limit(1);
  if (!row || (row.whiteId !== bot.id && row.blackId !== bot.id)) {
    throw new DomainError('not_found', 'game not found', { reason: 'game_not_found' });
  }
  return row;
}

/** `row` as `bot` sees it, with its PGN when asked. */
export async function viewOf(
  tx: DbOrTx,
  row: GameRow,
  bot: UserRow,
  withPgn = false,
): Promise<GameView> {
  const [moves, [group], [white], [black]] = await Promise.all([
    listMoves(tx, row.id),
    tx.select().from(groups).where(eq(groups.id, row.groupId)).limit(1),
    tx.select().from(users).where(eq(users.id, row.whiteId)).limit(1),
    tx.select().from(users).where(eq(users.id, row.blackId)).limit(1),
  ]);
  const view = renderGame(
    { game: row, moves, group: group!, white: white!, black: black! },
    bot.id,
  );
  if (withPgn) view.pgn = await buildGamePgn(tx, row);
  return view;
}

/** The game as `bot` sees it. A game that does not exist, or that the bot is not in, is `not_found`. */
export async function loadGameView(
  tx: DbOrTx,
  bot: UserRow,
  publicId: string,
  withPgn = false,
): Promise<GameView> {
  return viewOf(tx, await findBotGame(tx, bot, publicId), bot, withPgn);
}
