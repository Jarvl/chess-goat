import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveOwnBot, touchBotActivity } from '../../domain/bots';
import { setBotPremoves } from '../../domain/botPremoves';
import { registerTool } from '../tool';
import { botRef } from './manage';
import { findBotGame, gameText, gameViewSchema, viewOf } from './read';

/**
 * A premove tree as the agent sends it. Its nodes are checked by `checkPremoveShape`, which names
 * the bad path, with the limits; a recursive schema here would only give a vaguer error first, and
 * would recurse as deep as the tree.
 */
export const premoveTreeInput = z
  .array(z.unknown())
  .describe(
    "Conditional premoves: a list of { move, reply, children } nodes, all UCI (e2e4, e7e8q). `move` is an opponent move; `reply` is your bot's answer, played at once if the opponent plays `move`; `children` is the same kind of list for the position after both. At most 218 nodes in a list, 8,000 in all, and no `move` twice in one list. Legality isn't checked now: a reply that turns out illegal when it would fire drops the tree, and get_inbox says so. [] clears it.",
  );

function registerSetPremoves(server: McpServer): void {
  registerTool(server, {
    name: 'set_premoves',
    description:
      "Replaces one of your bots' premove tree in a game, on the opponent's turn only. When the opponent plays a move in the tree, the bot's reply is played at once, and the tree continues from that node's children. Copy `ply` from get_game into expected_ply. To set premoves together with a move, pass `premoves` to make_move instead.",
    input: z.object({
      bot: botRef,
      game_id: z.string().min(1).max(64).describe("The game's id, from get_inbox."),
      expected_ply: z.number().int().min(0).describe("The game's ply, from get_game."),
      tree: premoveTreeInput,
    }),
    output: gameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async ({ deps, owner }, input) => {
      const bot = await deps.db.transaction(async (tx) => {
        const bot = await resolveOwnBot(tx, owner.id, input.bot);
        await touchBotActivity(tx, bot.id);
        await findBotGame(tx, bot, input.game_id);
        return bot;
      });
      const row = await setBotPremoves(deps, {
        gameId: input.game_id,
        botId: bot.id,
        expectedPly: input.expected_ply,
        tree: input.tree,
      });
      return deps.db.transaction((tx) => viewOf(tx, row, bot));
    },
    text: gameText,
  });
}

export const registerPremoveTools = (server: McpServer): void => {
  registerSetPremoves(server);
};
