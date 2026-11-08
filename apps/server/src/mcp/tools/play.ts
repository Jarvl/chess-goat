import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { acceptChallenge, declineChallenge, getChallengeByPublicId } from '../../domain/challenges';
import { checkPremoveShape } from '../../domain/botPremoves';
import { DomainError } from '../../domain/errors';
import { abortGame, playMove, resign } from '../../domain/games';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../domain/draws';
import { registerTool, resolveAndTouch } from '../tool';
import { GameViewSchema, loadGameView } from '../../domain/botView';
import { gameText } from './read';
import { botRef } from './manage';
import { premoveTreeInput } from './premoves';

function registerMakeMove(server: McpServer): void {
  registerTool(server, {
    name: 'make_move',
    description:
      'Plays a move for one of your bots. `move` is SAN (Nf3, O-O, e8=Q) or UCI (g1f3, e7e8q). Copy `ply` from get_game or get_inbox into expected_ply; if the position has moved on you get an error and should call get_game. Calling again with the same arguments is safe: it returns the current game. `premoves` also sets the premove tree for the position after the move, as set_premoves does. On a retry of a move already played, premoves are ignored; call set_premoves.',
    input: z.object({
      bot: botRef,
      game_id: z.string().min(1).max(64).describe("The game's id, from get_inbox."),
      move: z.string().min(2).max(16).describe('SAN or UCI.'),
      expected_ply: z.number().int().min(0).describe("The game's ply when you chose this move."),
      premoves: premoveTreeInput.optional(),
    }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps } = call;
      const bot = await resolveAndTouch(call, input.bot);
      // Checked before anything is played, so a malformed tree never leaves a move without it.
      const premoves = input.premoves
        ? { tree: checkPremoveShape(input.premoves), ifIllegal: 'record' as const }
        : undefined;
      await playMove(deps, {
        gameId: input.game_id,
        userId: bot.id,
        move: input.move,
        expectedPly: input.expected_ply,
        premoves,
      });
      return deps.db.transaction((tx) => loadGameView(tx, bot, input.game_id));
    },
    text: gameText,
  });
}

const ACTIONS = [
  'offer_draw',
  'accept_draw',
  'decline_draw',
  'claim_draw',
  'resign',
  'abort',
] as const;

function registerGameAction(server: McpServer): void {
  registerTool(server, {
    name: 'game_action',
    description:
      "Draw and game-ending actions for one of your bots: offer_draw, accept_draw or decline_draw (answering the opponent's offer), claim_draw (threefold repetition or fifty moves), resign, or abort (only before both sides have moved). resign and abort end the game.",
    input: z.object({
      bot: botRef,
      game_id: z.string().min(1).max(64).describe("The game's id, from get_inbox."),
      action: z.enum(ACTIONS),
    }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (call, input) => {
      const { deps } = call;
      const bot = await resolveAndTouch(call, input.bot);
      const act = { gameId: input.game_id, userId: bot.id };
      switch (input.action) {
        case 'offer_draw':
          await offerDraw(deps, act);
          break;
        case 'accept_draw':
          await acceptDraw(deps, act);
          break;
        case 'decline_draw':
          await declineDraw(deps, act);
          break;
        case 'claim_draw':
          await claimDraw(deps, act);
          break;
        case 'resign':
          await resign(deps, act);
          break;
        case 'abort':
          await abortGame(deps, act);
          break;
      }
      return deps.db.transaction((tx) => loadGameView(tx, bot, input.game_id));
    },
    text: gameText,
  });
}

const respondOutput = z.object({ accepted: z.boolean(), game: GameViewSchema.optional() });

function registerRespondToChallenge(server: McpServer): void {
  registerTool(server, {
    name: 'respond_to_challenge',
    description:
      "Accepts or declines a challenge made to one of your bots by name (see get_inbox). Accepting starts the game and returns it. Bots can't take open challenges.",
    input: z.object({
      bot: botRef,
      challenge_id: z.string().min(1).max(64).describe("The challenge's id, from get_inbox."),
      accept: z.boolean(),
    }),
    output: respondOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps } = call;
      const bot = await resolveAndTouch(call, input.bot);
      const challenge = await deps.db.transaction(async (tx) => {
        const challenge = await getChallengeByPublicId(tx, input.challenge_id);
        // A challenge that is not made to this bot by name (an open one, or one it sent) looks like
        // one that does not exist.
        if (!challenge || challenge.opponentId !== bot.id) {
          throw new DomainError('not_found', 'challenge not found', {
            reason: 'challenge_not_found',
          });
        }
        return challenge;
      });
      if (!input.accept) {
        await declineChallenge(deps, { challengeId: challenge.id, userId: bot.id });
        return { accepted: false };
      }
      const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bot.id });
      return {
        accepted: true,
        game: await deps.db.transaction((tx) => loadGameView(tx, bot, game.publicId)),
      };
    },
    text: (out) =>
      out.game ? `Challenge accepted.\n${gameText(out.game)}` : 'Challenge declined.',
  });
}

export const registerPlayTools = (server: McpServer): void => {
  registerMakeMove(server);
  registerGameAction(server);
  registerRespondToChallenge(server);
};
