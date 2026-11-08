import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { PlayerKindSchema } from '@chess-goat/shared';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { games, groups, users, type GameRow, type UserRow } from '../../db/schema';
import type { DbOrTx } from '../../db/client';
import { DomainError } from '../../domain/errors';
import { listMoves } from '../../domain/games';
import { buildGamePgn } from '../../domain/pgn';
import { displayName } from '../../domain/users';
import { registerTool, resolveAndTouch } from '../tool';
import { renderGame, type GameView } from '../render';
import { botViews } from '../../domain/bots';
import { botRef, botSchema, READ_ONLY } from './manage';

const colour = z.enum(['white', 'black']);
const premoveNode: z.ZodType<{ move: string; reply: string; children: unknown[] }> = z.lazy(() =>
  z.object({ move: z.string(), reply: z.string(), children: z.array(premoveNode) }),
);

export const gameViewSchema = z.object({
  gameId: z.string(),
  group: z.object({ groupId: z.string(), title: z.string() }),
  you: colour,
  opponent: z.object({ name: z.string(), kind: PlayerKindSchema }),
  status: z.string(),
  result: z.string().nullable(),
  endReason: z.string().nullable(),
  ply: z.number().int(),
  toMove: colour,
  yourTurn: z.boolean(),
  fen: z.string(),
  board: z.string(),
  moves: z.array(z.string()),
  legalMoves: z.array(z.object({ san: z.string(), uci: z.string() })),
  timePerMove: z.number().nullable(),
  deadlineAt: z.string().nullable(),
  drawOffer: z.enum(['none', 'from_you', 'from_opponent']),
  rated: z.boolean(),
  premoveTree: z.array(premoveNode),
  pgn: z.string().optional(),
});

export const gameText = (view: z.infer<typeof gameViewSchema>): string => {
  const head = view.yourTurn
    ? `Your move (${view.you}), ply ${view.ply}.`
    : view.status === 'active'
      ? `Waiting for ${view.opponent.name} (${view.toMove} to move), ply ${view.ply}.`
      : `Game over: ${view.result ?? '*'} by ${view.endReason ?? 'unknown'}, ply ${view.ply}.`;
  const legal = view.yourTurn
    ? `\nLegal moves: ${view.legalMoves.map((m) => `${m.san} (${m.uci})`).join(', ')}`
    : '';
  const draw =
    view.drawOffer === 'none'
      ? ''
      : `\nDraw offer ${view.drawOffer === 'from_you' ? 'from you' : 'from your opponent'}.`;
  return `${head} vs ${view.opponent.name} in ${view.group.title}.\n${view.board}\nFEN: ${view.fen}${legal}${draw}`;
};

/** The game as `bot` sees it. A game that does not exist, or that the bot is not in, is `not_found`. */
export async function loadGameView(
  tx: DbOrTx,
  bot: UserRow,
  publicId: string,
  withPgn = false,
): Promise<GameView> {
  const row = await findBotGame(tx, bot, publicId);
  return viewOf(tx, row, bot, withPgn);
}

export async function findBotGame(tx: DbOrTx, bot: UserRow, publicId: string): Promise<GameRow> {
  const [row] = await tx.select().from(games).where(eq(games.publicId, publicId)).limit(1);
  if (!row || (row.whiteId !== bot.id && row.blackId !== bot.id)) {
    throw new DomainError('not_found', 'game not found', { reason: 'game_not_found' });
  }
  return row;
}

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

function registerGetGame(server: McpServer): void {
  registerTool(server, {
    name: 'get_game',
    description:
      "A game one of your bots plays in: the board from the bot's side, the moves so far, and, when it is the bot's turn, every legal move in SAN and UCI. Copy `ply` into expected_ply when moving. format 'detailed' adds the PGN.",
    input: z.object({
      bot: botRef,
      game_id: z.string().min(1).max(64).describe("The game's id, from get_inbox."),
      format: z.enum(['concise', 'detailed']).optional(),
    }),
    output: gameViewSchema,
    annotations: READ_ONLY,
    run: async (call, input) => {
      const bot = await resolveAndTouch(call, input.bot);
      return call.deps.db.transaction((tx) =>
        loadGameView(tx, bot, input.game_id, input.format === 'detailed'),
      );
    },
    text: gameText,
  });
}

const RECENT_GAMES = 10;

function registerGetProfile(server: McpServer): void {
  registerTool(server, {
    name: 'get_profile',
    description:
      "One of your bots: its groups and ratings, how many games it is playing, and its ten most recent finished games (result is from the bot's side: win, loss or draw).",
    input: z.object({ bot: botRef }),
    output: z.object({
      bot: botSchema,
      recentGames: z.array(
        z.object({
          gameId: z.string(),
          opponent: z.string(),
          result: z.enum(['win', 'loss', 'draw']).nullable(),
          finishedAt: z.string().nullable(),
        }),
      ),
    }),
    annotations: READ_ONLY,
    run: async (call, input) => {
      const bot = await resolveAndTouch(call, input.bot);
      return call.deps.db.transaction(async (tx) => {
        const [view] = await botViews(tx, [bot]);
        const rows = await tx
          .select({ game: games })
          .from(games)
          .where(
            and(
              eq(games.status, 'finished'),
              isNull(games.voidedAt),
              or(eq(games.whiteId, bot.id), eq(games.blackId, bot.id)),
            ),
          )
          .orderBy(desc(games.finishedAt), desc(games.id))
          .limit(RECENT_GAMES);
        const opponentIds = rows.map(({ game }) =>
          game.whiteId === bot.id ? game.blackId : game.whiteId,
        );
        const people = opponentIds.length
          ? await tx
              .select()
              .from(users)
              .where(or(...opponentIds.map((id) => eq(users.id, id))))
          : [];
        return {
          bot: view!,
          recentGames: rows.map(({ game }) => {
            const white = game.whiteId === bot.id;
            const opponent = people.find((p) => p.id === (white ? game.blackId : game.whiteId));
            const result =
              game.result === '1/2-1/2'
                ? ('draw' as const)
                : game.result === null
                  ? null
                  : (game.result === '1-0') === white
                    ? ('win' as const)
                    : ('loss' as const);
            return {
              gameId: game.publicId,
              opponent: opponent ? displayName(opponent) : 'Unknown',
              result,
              finishedAt: game.finishedAt?.toISOString() ?? null,
            };
          }),
        };
      });
    },
    text: ({ bot, recentGames }) =>
      `${bot.label}: ${bot.groups.map((g) => `${g.title} ${g.rating}`).join(', ') || 'in no group'}.` +
      (recentGames.length === 0
        ? ' No finished games yet.'
        : `\nRecent games:\n${recentGames
            .map((g) => `${g.gameId} vs ${g.opponent}: ${g.result ?? 'no result'}`)
            .join('\n')}`),
  });
}

export const registerReadTools = (server: McpServer): void => {
  registerGetGame(server);
  registerGetProfile(server);
};
