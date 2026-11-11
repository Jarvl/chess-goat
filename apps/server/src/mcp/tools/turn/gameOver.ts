import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { touchBotActivity } from '../../../domain/bots';
import { isDomainError, DomainError } from '../../../domain/errors';
import { mayPlay } from '../../../domain/pairing';
import { registerTurnTool } from '../../tool';
import {
  challengeBot,
  challengeSentOutput,
  challengeSettings,
  FIND_BOTS_HOW,
  findBotsFilters,
  findBotsIn,
  findBotsText,
  foundBotsOutput,
} from '../challenge';
import { READ_ONLY } from '../manage';
import { turnGame } from './shared';

function registerFindBots(server: McpServer): void {
  registerTurnTool(server, {
    name: 'find_bots',
    description: `Finds another bot to play next: live bots in the group your game was in, ${FIND_BOTS_HOW}`,
    input: z.object(findBotsFilters),
    output: foundBotsOutput,
    annotations: READ_ONLY,
    run: async (call, input) => {
      const { deps, bot } = call;
      const game = await turnGame(call);
      return deps.db.transaction(async (tx) => {
        // The rule the pairing check applies to a challenger.
        try {
          await mayPlay(tx, game.groupId, bot);
        } catch (error) {
          if (isDomainError(error) && error.code === 'forbidden') {
            throw new DomainError('forbidden', 'your bot cannot play in this group', {
              reason: 'turn_bot_not_in_group',
            });
          }
          throw error;
        }
        return findBotsIn(tx, game.groupId, { ...input, excludeId: bot.id });
      });
    },
    text: findBotsText,
  });
}

function registerChallengeBot(server: McpServer): void {
  registerTurnTool(server, {
    name: 'challenge_bot',
    description:
      "Challenges another bot (an id from find_bots) to a new game in the same group. The challenge goes to that bot's runner and expires in 24 hours. Bots can't challenge people. Games between two bots may have no clock (time_per_move null, the default). Challenges between bots of one owner are always casual.",
    input: z.object(challengeSettings),
    output: challengeSentOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps, bot } = call;
      const game = await turnGame(call);
      const sent = await challengeBot(deps, {
        challengerId: bot.id,
        groupId: game.groupId,
        ...input,
      });
      await touchBotActivity(deps.db, bot.id);
      return sent;
    },
    text: ({ challengeId, expiresAt }) =>
      `Challenge ${challengeId} sent. It expires at ${expiresAt}. Its runner plays the game once the other bot accepts; you need do nothing more.`,
  });
}

export const registerGameOverTurnTools = (server: McpServer): void => {
  registerFindBots(server);
  registerChallengeBot(server);
};
