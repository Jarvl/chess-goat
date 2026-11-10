import type { TurnKind } from '@chess-goat/shared';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { registerChallengeTools } from './tools/challenge';
import { registerManageTools } from './tools/manage';
import { registerReadTools } from './tools/read';
import { registerRunnerTools } from './tools/runners';
import { registerChallengeTurnTools } from './tools/turn/challenge';
import { registerDrawOfferTurnTools } from './tools/turn/drawOffer';
import { registerGameOverTurnTools } from './tools/turn/gameOver';
import { registerMoveTurnTools } from './tools/turn/move';
import { registerNotesTurnTool } from './tools/turn/notes';
import { registerPracticeTurnTools } from './tools/turn/practice';

/**
 * Sent in the owner surface's identity; clients show it to the agent before any tool call. An owner
 * types one request and the agent follows this path with no other documentation.
 */
export const OWNER_INSTRUCTIONS =
  "Chess Goat runs correspondence chess in Telegram groups. You set up your owner's bots (🤖); you do not play their games. A runner on the owner's machine starts a short session for each thing a bot must respond to, using the bot's persona. Bots cannot challenge people: they answer people's challenges and may challenge other bots. To set a bot up, in order: (1) create_bot with a persona and groups; (2) link_runner, unless the result of create_bot says a runner already serves it; (3) run the command link_runner returns if you have a shell, otherwise give it to the owner and wait, and tell the owner the runner now starts at login and that `goat-runner autostart off` undoes that; (4) test_runner until it says the bot is live, or tells you what failed; if it is not live after a few tries, tell your owner what it says; (5) if the owner wants games, find_bots then challenge_bot. If the owner is in several groups and named none, ask which. Anything the owner wants the bot to keep doing must be written into the persona: later sessions know only the persona and the bot's notes.";

/** The `set_up_bot` prompt's one message for an owner's description of the bot they want. */
export const setUpBotPrompt = (description: string): string =>
  `Set up a Chess Goat bot for me from this description: ${description}\n\nDo this in order: (1) call list_my_groups; if I am in several groups and the description names none, ask me which. (2) Write a persona from the description, in the second person, covering how the bot plays, which challenges it accepts, when it offers, accepts or declines a draw, whether it challenges other bots after a game ends, and what it keeps in its notes; then call create_bot with a name, the persona and the group. (3) If create_bot says no runner serves the bot, call link_runner, passing the preset for the harness you are running in if it is one it lists. Run the command it returns if you have a shell; otherwise give it to me and wait until I say it has run. Tell me the runner now starts at login and that \`goat-runner autostart off\` undoes that. (4) Call test_runner until it says the bot is live, or tells you what failed. If it is not live after a few tries, tell me what it says. (5) If the description asks for games against other bots, call find_bots and then challenge_bot for one or two bots that are online. Then tell me what you did. You do not play the games yourself: the runner does.`;

/** The turn surface's identity: the turn's own instructions come in the runner's message. */
export const TURN_INSTRUCTIONS =
  'You are playing one turn for a Chess Goat bot. Your instructions are in the message you were given. Use only the tools listed, then stop.';

/** Every tool, in the order `tools/list` gives them. */
const TOOLS: readonly ((server: McpServer) => void)[] = [
  registerManageTools,
  registerRunnerTools,
  registerReadTools,
  registerChallengeTools,
];

/** The owner surface, fresh per request (the SDK's stateless handler calls this for each one). */
export function createOwnerServer(): McpServer {
  const server = new McpServer(
    { name: 'chess-goat', version: '1.0.0' },
    { instructions: OWNER_INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  );
  for (const register of TOOLS) register(server);
  server.registerPrompt(
    'set_up_bot',
    {
      title: 'Set up a bot',
      description:
        'Create a bot from a description, connect its runner, test it, and optionally start games.',
      argsSchema: z.object({
        description: z
          .string()
          .min(1)
          .max(2000)
          .describe('What the bot should be like, and whether it should challenge other bots.'),
      }),
    },
    ({ description }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: setUpBotPrompt(description) } }],
    }),
  );
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
      registerPracticeTurnTools(server);
      break;
  }
  return server;
}
