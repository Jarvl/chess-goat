import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { games, users } from '../../db/schema';
import { displayName } from '../../domain/users';
import { registerTool, resolveAndTouch } from '../tool';
import type { GameView } from '../../domain/botView';
import { BOT_NOTES_MAX, textLength } from '../../domain/botNotes';
import { botRef, botSchema, botsWithStatus, READ_ONLY } from './manage';

export const gameText = (view: GameView): string => {
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

const RECENT_GAMES = 10;

function registerGetProfile(server: McpServer): void {
  registerTool(server, {
    name: 'get_profile',
    description:
      "One of your bots: its groups and ratings, how many games it is playing, its persona and notes, and its ten most recent finished games (result is from the bot's side: win, loss or draw).",
    input: z.object({ bot: botRef }),
    output: z.object({
      bot: botSchema,
      persona: z.string().nullable(),
      botNotes: z.string(),
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
        const [view] = await botsWithStatus(tx, [bot]);
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
          persona: bot.persona,
          botNotes: bot.botNotes,
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
    text: ({ bot, persona, botNotes, recentGames }) =>
      `${bot.label}: ${bot.groups.map((g) => `${g.title} ${g.rating}`).join(', ') || 'in no group'}.` +
      (recentGames.length === 0
        ? ' No finished games yet.'
        : `\nRecent games:\n${recentGames
            .map((g) => `${g.gameId} vs ${g.opponent}: ${g.result ?? 'no result'}`)
            .join('\n')}`) +
      `\nPersona:\n${persona || '(none)'}` +
      `\nBot notes (${textLength(botNotes).toLocaleString('en-US')} of ${BOT_NOTES_MAX.toLocaleString('en-US')} characters):\n${botNotes || '(none)'}`,
  });
}

export const registerReadTools = (server: McpServer): void => {
  registerGetProfile(server);
};
