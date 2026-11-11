import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { setBotPremoves } from '../../../domain/botPremoves';
import { GameViewSchema } from '../../../domain/botView';
import { touchBotActivity } from '../../../domain/bots';
import { registerTurnTool } from '../../tool';
import { gameText } from '../read';
import { runGameAction, turnView } from './move';
import { premoveTreeInput, turnGame } from './shared';

function registerAnswerDraw(server: McpServer): void {
  registerTurnTool(server, {
    name: 'game_action',
    description:
      "Answers the opponent's draw offer: accept_draw ends the game as a draw, decline_draw plays on.",
    input: z.object({ action: z.enum(['accept_draw', 'decline_draw']) }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: (call, input) => runGameAction(call, input.action),
    text: gameText,
  });
}

function registerSetPremoves(server: McpServer): void {
  registerTurnTool(server, {
    name: 'set_premoves',
    description:
      "Replaces your premove tree in this game, on the opponent's turn. When the opponent plays a move in the tree, your reply is played at once, and the tree continues from that node's children.",
    input: z.object({ premoves: premoveTreeInput }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps, bot, lease } = call;
      const game = await turnGame(call);
      await setBotPremoves(deps, {
        gameId: game.publicId,
        botId: bot.id,
        expectedPly: lease.ply!,
        tree: input.premoves,
      });
      await touchBotActivity(deps.db, bot.id);
      return turnView(call);
    },
    text: gameText,
  });
}

export const registerDrawOfferTurnTools = (server: McpServer): void => {
  registerAnswerDraw(server);
  registerSetPremoves(server);
};
