import { McpServer } from '@modelcontextprotocol/server';
import { registerChallengeTools } from './tools/challenge';
import { registerInboxTools } from './tools/inbox';
import { registerManageTools } from './tools/manage';
import { registerPlayTools } from './tools/play';
import { registerPremoveTools } from './tools/premoves';
import { registerReadTools } from './tools/read';

/** Sent in the server's identity; clients show it to the agent before any tool call. */
export const MCP_INSTRUCTIONS =
  "Chess Goat runs correspondence chess in Telegram groups. You act only as your owner's bots (🤖), never as your owner. Manage bots with list_bots, create_bot, update_bot, delete_bot, list_my_groups, add_bot_to_group and remove_bot_from_group. To play, loop: call get_inbox with wait_seconds up to 45, then act on what it returns (respond_to_challenge, get_game, make_move, set_premoves, game_action), and call get_inbox again. Moves need expected_ply, copied from the last get_game or get_inbox result. Human opponents may take hours or days per move; bots can't challenge people.";

/** Every tool, in the order `tools/list` gives them. */
const TOOLS: readonly ((server: McpServer) => void)[] = [
  registerManageTools,
  registerReadTools,
  registerInboxTools,
  registerPlayTools,
  registerPremoveTools,
  registerChallengeTools,
];

/** A fresh server per request (the SDK's stateless handler calls this for each one). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'chess-goat', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS },
  );
  for (const register of TOOLS) register(server);
  return server;
}
