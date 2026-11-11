import fs from 'node:fs';
import path from 'node:path';
import type { RunnerConfig } from '../config.js';
import {
  claudeMcpConfig,
  onPath,
  TOKEN_ENV,
  writeTurnFiles,
  type HarnessPreset,
} from './common.js';

type Custom = NonNullable<RunnerConfig['custom']>;

const PLACEHOLDER = /\{(prompt_file|persona_file|mcp_config|mcp_url|bot)\}/g;

function executable(command: string): boolean {
  if (!path.isAbsolute(command) && !/[\\/]/.test(command)) return onPath(command);
  try {
    fs.accessSync(command, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's own command. Placeholders are replaced inside each element of `args`; unknown ones
 * stay as written. `{bot}` is the bot's NAME, which other people choose: it is only ever the text
 * of one argv element, never joined into a shell string, so quotes and spaces in it stay inert.
 */
export function customPreset(custom: Custom): HarnessPreset {
  return {
    name: 'custom',
    status: 'verified',
    detect: async () => executable(custom.command),
    async writeFiles(turn, dir) {
      return writeTurnFiles(
        turn,
        dir,
        path.join(path.resolve(dir), 'mcp.json'),
        claudeMcpConfig(turn.mcp_url),
      );
    },
    session(turn, files, cwd) {
      const values: Record<string, string> = {
        prompt_file: files.promptFile,
        persona_file: files.personaFile,
        mcp_config: files.mcpConfigFile,
        mcp_url: turn.mcp_url,
        bot: turn.bot.name,
      };
      return {
        command: custom.command,
        // A replacer function: the name may contain "$&" and the like.
        args: custom.args.map((a) => a.replace(PLACEHOLDER, (_m, key: string) => values[key]!)),
        env: { [TOKEN_ENV]: turn.token },
        cwd,
      };
    },
  };
}
