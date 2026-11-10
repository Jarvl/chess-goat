import type { TurnKind } from '@chess-goat/shared';
import { McpServer } from '@modelcontextprotocol/server';
import { registerChallengeTools } from './tools/challenge';
import { registerManageTools } from './tools/manage';
import { registerReadTools } from './tools/read';
import { registerChallengeTurnTools } from './tools/turn/challenge';
import { registerDrawOfferTurnTools } from './tools/turn/drawOffer';
import { registerGameOverTurnTools } from './tools/turn/gameOver';
import { registerMoveTurnTools } from './tools/turn/move';
import { registerNotesTurnTool } from './tools/turn/notes';

/** Sent in the server's identity; clients show it to the agent before any tool call. */
export const MCP_INSTRUCTIONS =
  "Chess Goat runs correspondence chess in Telegram groups. You set up your owner's bots (🤖); you do not play their games. Manage bots with list_bots, create_bot, update_bot, delete_bot, list_my_groups, add_bot_to_group and remove_bot_from_group. Bots can't challenge people.";

/** The turn surface's identity: the turn's own instructions come in the runner's message. */
export const TURN_INSTRUCTIONS =
  'You are playing one turn for a Chess Goat bot. Your instructions are in the message you were given. Use only the tools listed, then stop.';

/** Every tool, in the order `tools/list` gives them. */
const TOOLS: readonly ((server: McpServer) => void)[] = [
  registerManageTools,
  registerReadTools,
  registerChallengeTools,
];

/** The owner surface, fresh per request (the SDK's stateless handler calls this for each one). */
export function createOwnerServer(): McpServer {
  const server = new McpServer(
    { name: 'chess-goat', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  );
  for (const register of TOOLS) register(server);
  return server;
}

/**
 * The turn surface for one kind of turn, fresh per request. It offers tools even when a kind has
 * none, so `tools/list` answers (empty) rather than "method not found".
 */
export function createTurnServer(kind: TurnKind): McpServer {
  const server = new McpServer(
    { name: 'chess-goat', version: '1.0.0' },
    { instructions: TURN_INSTRUCTIONS, capabilities: { tools: {} } },
  );
  switch (kind) {
    case 'challenge':
      registerChallengeTurnTools(server);
      registerNotesTurnTool(server);
      break;
    case 'move':
      registerMoveTurnTools(server);
      registerNotesTurnTool(server);
      break;
    case 'draw_offer':
      registerDrawOfferTurnTools(server);
      registerNotesTurnTool(server);
      break;
    case 'game_over':
      registerGameOverTurnTools(server);
      registerNotesTurnTool(server);
      break;
    case 'practice':
      break;
  }
  return server;
}
