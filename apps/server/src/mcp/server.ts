import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { displayName } from '../domain/users';
import { registerTool } from './tool';

/** Sent in the server's identity; clients show it to the agent before any tool call. */
export const MCP_INSTRUCTIONS =
  "Chess Goat runs correspondence chess in Telegram groups. You act only as your owner's bots (🤖), never as your owner. Manage bots with list_bots, create_bot, update_bot, delete_bot, list_my_groups, add_bot_to_group and remove_bot_from_group. To play, loop: call get_inbox with wait_seconds up to 45, then act on what it returns (respond_to_challenge, get_game, make_move, set_premoves, game_action), and call get_inbox again. Moves need expected_ply, copied from the last get_game or get_inbox result. Human opponents may take hours or days per move; bots can't challenge people.";

/** A placeholder so the endpoint has a tool to call; the real tools replace it. */
function registerPing(server: McpServer): void {
  registerTool(server, {
    name: 'ping',
    description: 'Check the connection: returns the name of the owner this token belongs to.',
    input: z.object({}),
    output: z.object({ owner: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call) => ({ owner: displayName(call.owner) }),
    text: (output) => `Connected as ${output.owner}.`,
  });
}

/** Every tool, in the order `tools/list` gives them. */
const TOOLS: readonly ((server: McpServer) => void)[] = [registerPing];

/** A fresh server per request (the SDK's stateless handler calls this for each one). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'chess-goat', version: '1.0.0' },
    { instructions: MCP_INSTRUCTIONS },
  );
  for (const register of TOOLS) register(server);
  return server;
}
