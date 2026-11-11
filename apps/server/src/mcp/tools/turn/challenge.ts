import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { GameViewSchema, loadGameView } from '../../../domain/botView';
import { touchBotActivity } from '../../../domain/bots';
import { acceptChallenge, declineChallenge, getChallengeById } from '../../../domain/challenges';
import { DomainError } from '../../../domain/errors';
import { registerTurnTool } from '../../tool';
import { gameText } from '../read';

const output = z.object({ accepted: z.boolean(), game: GameViewSchema.optional() });

function registerRespondToChallenge(server: McpServer): void {
  registerTurnTool(server, {
    name: 'respond_to_challenge',
    description:
      'Accepts or declines the challenge made to you. Accepting starts the game and returns it.',
    input: z.object({ accept: z.boolean() }),
    output,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps, bot, lease } = call;
      const challenge =
        lease.challengeId === null
          ? null
          : await deps.db.transaction((tx) => getChallengeById(tx, lease.challengeId!));
      if (!challenge || challenge.opponentId !== bot.id) {
        throw new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });
      }
      if (!input.accept) {
        await declineChallenge(deps, { challengeId: challenge.id, userId: bot.id });
        await touchBotActivity(deps.db, bot.id);
        return { accepted: false };
      }
      const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bot.id });
      await touchBotActivity(deps.db, bot.id);
      return {
        accepted: true,
        game: await deps.db.transaction((tx) => loadGameView(tx, bot, game.publicId)),
      };
    },
    text: (out) =>
      out.game ? `Challenge accepted.\n${gameText(out.game)}` : 'Challenge declined.',
  });
}

export const registerChallengeTurnTools = (server: McpServer): void => {
  registerRespondToChallenge(server);
};
