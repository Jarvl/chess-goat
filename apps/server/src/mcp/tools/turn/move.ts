import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { checkPremoveShape } from '../../../domain/botPremoves';
import { GameViewSchema, viewOf } from '../../../domain/botView';
import { touchBotActivity } from '../../../domain/bots';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../../domain/draws';
import { abortGame, playMove, resign } from '../../../domain/games';
import type { TurnCall } from '../../context';
import { registerTurnTool } from '../../tool';
import { READ_ONLY } from '../manage';
import { gameText } from '../read';
import { premoveTreeInput, turnGame } from './shared';

/** The turn's game as the bot sees it now. */
export async function turnView(call: TurnCall, withPgn = false) {
  const game = await turnGame(call);
  return call.deps.db.transaction((tx) => viewOf(tx, game, call.bot, withPgn));
}

function registerGetPosition(server: McpServer): void {
  registerTurnTool(server, {
    name: 'get_position',
    description:
      "The game you are playing this turn: the board from your side, the moves so far and every legal move in SAN and UCI. format 'detailed' adds the PGN.",
    input: z.object({ format: z.enum(['detailed']).optional() }),
    output: GameViewSchema,
    annotations: READ_ONLY,
    run: (call, input) => turnView(call, input.format === 'detailed'),
    text: gameText,
  });
}

function registerMakeMove(server: McpServer): void {
  registerTurnTool(server, {
    name: 'make_move',
    description:
      'Plays your move. `move` is SAN (Nf3, O-O, e8=Q) or UCI (g1f3, e7e8q). `premoves` also sets the premove tree for the position after the move, as set_premoves does. You get one move per turn; then stop.',
    input: z.object({
      move: z.string().min(2).max(16).describe('SAN or UCI.'),
      premoves: premoveTreeInput.optional(),
    }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps, bot, lease } = call;
      const game = await turnGame(call);
      // Checked before anything is played, so a malformed tree never leaves a move without it.
      const premoves = input.premoves
        ? { tree: checkPremoveShape(input.premoves), ifIllegal: 'record' as const }
        : undefined;
      await playMove(deps, {
        gameId: game.publicId,
        userId: bot.id,
        move: input.move,
        // A move turn always has its ply.
        expectedPly: lease.ply!,
        premoves,
      });
      await touchBotActivity(deps.db, bot.id);
      return turnView(call);
    },
    text: gameText,
  });
}

const MOVE_ACTIONS = [
  'offer_draw',
  'accept_draw',
  'decline_draw',
  'claim_draw',
  'resign',
  'abort',
] as const;

type Action = (typeof MOVE_ACTIONS)[number];

/** Runs `action` for the turn's bot and returns the game as it stands. */
export async function runGameAction(call: TurnCall, action: Action) {
  const { deps, bot } = call;
  const game = await turnGame(call);
  const act = { gameId: game.publicId, userId: bot.id };
  switch (action) {
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
  await touchBotActivity(deps.db, bot.id);
  return turnView(call);
}

function registerGameAction(server: McpServer): void {
  registerTurnTool(server, {
    name: 'game_action',
    description:
      "Draw and game-ending actions instead of a move: offer_draw, accept_draw or decline_draw (answering the opponent's offer), claim_draw (threefold repetition or fifty moves), resign, or abort (only before both sides have moved). resign and abort end the game.",
    input: z.object({ action: z.enum(MOVE_ACTIONS) }),
    output: GameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: (call, input) => runGameAction(call, input.action),
    text: gameText,
  });
}

export const registerMoveTurnTools = (server: McpServer): void => {
  registerGetPosition(server);
  registerMakeMove(server);
  registerGameAction(server);
};
