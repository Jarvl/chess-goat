import { INITIAL_FEN, type PremoveNode } from '@chess-goat/shared';
import { Chess } from 'chess.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { UserRow } from '../../db/schema';
import { resolveOwnBot, touchBotActivity } from '../../domain/bots';
import { acceptChallenge, declineChallenge, getChallengeByPublicId } from '../../domain/challenges';
import { checkPremoveShape } from '../../domain/botPremoves';
import { DomainError } from '../../domain/errors';
import { abortGame, listMoves, playMove, resign } from '../../domain/games';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../domain/draws';
import { registerTool } from '../tool';
import { gameText, gameViewSchema, findBotGame, loadGameView } from './read';
import { botRef } from './manage';
import { premoveTreeInput } from './premoves';

const LEGAL_MOVES_SHOWN = 30;
const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

type Resolved = { uci: string } | { uci: null; legal: string };

/** `move` (SAN or UCI) on `fen`: its UCI, or the legal moves (up to 30) to choose from. */
function resolveMove(fen: string, move: string): Resolved {
  const chess = new Chess(fen);
  const uci = UCI.exec(move.trim());
  try {
    const played = uci
      ? chess.move({ from: uci[1]!, to: uci[2]!, promotion: uci[3] })
      : chess.move(move.trim());
    return { uci: `${played.from}${played.to}${played.promotion ?? ''}` };
  } catch {
    const legal = new Chess(fen)
      .moves({ verbose: true })
      .slice(0, LEGAL_MOVES_SHOWN)
      .map((m) => `${m.san} (${m.from}${m.to}${m.promotion ?? ''})`)
      .join(', ');
    return { uci: null, legal };
  }
}

const stale = (plyCount: number) =>
  new DomainError('stale_state', 'the position has changed', { plyCount });

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
    output: gameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async ({ deps, owner }, input) => {
      let premoveNodes: PremoveNode[] = [];
      const { bot, move } = await deps.db.transaction(async (tx) => {
        const bot = await resolveOwnBot(tx, owner.id, input.bot);
        await touchBotActivity(tx, bot.id);
        // Checked before anything is played, so a malformed tree never leaves a move without it.
        if (input.premoves) premoveNodes = checkPremoveShape(input.premoves);
        const row = await findBotGame(tx, bot, input.game_id);
        if (input.expected_ply > row.plyCount) throw stale(row.plyCount);
        const history = await listMoves(tx, row.id);
        const fen =
          input.expected_ply === row.plyCount
            ? row.fen
            : input.expected_ply === 0
              ? INITIAL_FEN
              : history[input.expected_ply - 1]!.fenAfter;
        const resolved = resolveMove(fen, input.move);
        const clientMoveId = (u: string) => `mcp:${bot.id}:${row.id}:${input.expected_ply}:${u}`;
        // A retry of a move already made returns the game as it is now, whatever has happened since.
        if (resolved.uci && history.some((m) => m.clientMoveId === clientMoveId(resolved.uci))) {
          return { bot, move: null };
        }
        if (row.status !== 'active') {
          throw new DomainError('stale_state', 'the game is over');
        }
        if (input.expected_ply !== row.plyCount) throw stale(row.plyCount);
        const botIsWhite = row.whiteId === bot.id;
        if ((fen.split(' ')[1] === 'w') !== botIsWhite) {
          throw new DomainError('not_your_turn', 'not your turn');
        }
        if (resolved.uci === null) {
          throw new DomainError('illegal_move', 'illegal move', {
            move: input.move.trim(),
            legal: resolved.legal,
          });
        }
        return { bot, move: { uci: resolved.uci, clientMoveId: clientMoveId(resolved.uci) } };
      });
      if (move !== null) {
        await playMove(deps, {
          gameId: input.game_id,
          userId: bot.id,
          expectedPly: input.expected_ply,
          ...move,
          premoveNodes,
          premoveCheck: 'shape',
        });
      }
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
    output: gameViewSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async ({ deps, owner }, input) => {
      const bot = await deps.db.transaction(async (tx) => {
        const bot = await resolveOwnBot(tx, owner.id, input.bot);
        await touchBotActivity(tx, bot.id);
        await findBotGame(tx, bot, input.game_id);
        return bot;
      });
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

const respondOutput = z.object({ accepted: z.boolean(), game: gameViewSchema.optional() });

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
    run: async ({ deps, owner }, input) => {
      const { bot, challenge } = await deps.db.transaction(async (tx) => {
        const bot: UserRow = await resolveOwnBot(tx, owner.id, input.bot);
        await touchBotActivity(tx, bot.id);
        const challenge = await getChallengeByPublicId(tx, input.challenge_id);
        // A challenge that is not the bot's to answer looks like one that does not exist.
        const mine =
          challenge && (challenge.opponentId === bot.id || challenge.opponentId === null);
        if (!challenge || !mine) {
          throw new DomainError('not_found', 'challenge not found', {
            reason: 'challenge_not_found',
          });
        }
        return { bot, challenge };
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
