import path from 'node:path';
import {
  claudeMcpConfig,
  detectOnPath,
  personaOf,
  SERVER_NAME,
  TOKEN_ENV,
  writeTurnFiles,
  type HarnessPreset,
} from './common.js';

// Flags checked against `claude --help` of 2.1.322:
// - `-p` prints and exits; `--system-prompt` replaces the whole system prompt (not appended).
// - `--mcp-config` + `--strict-mcp-config`: only our server. `--allowedTools mcp__chess-goat` allows
//   every tool of that server; `--tools ""` turns every built-in off; `--permission-mode dontAsk`
//   denies whatever is not allowed instead of asking.
// - `--setting-sources user` skips project and local settings (and their hooks) yet keeps the
//   owner's login working; `--bare` would not (API key only), so it is not used.
//   `--disable-slash-commands` drops skills and commands.
// - `--system-prompt=` is one argument so a persona starting with "-" cannot be read as a flag;
//   `--` ends options so the same holds for the prompt (and the variadic flags cannot swallow it).
// - The MCP config references `${GOAT_TURN_TOKEN}`: Claude Code expands env vars in MCP config. To
//   be confirmed by the real run (not possible from --help).
export const claude: HarnessPreset = {
  name: 'claude',
  status: 'verified',
  detect: detectOnPath('claude'),
  async writeFiles(turn, dir) {
    return writeTurnFiles(
      turn,
      dir,
      path.join(path.resolve(dir), 'mcp.json'),
      claudeMcpConfig(turn.mcp_url),
    );
  },
  session(turn, files, cwd) {
    return {
      command: 'claude',
      args: [
        '-p',
        `--system-prompt=${personaOf(turn)}`,
        '--mcp-config',
        files.mcpConfigFile,
        '--strict-mcp-config',
        '--allowedTools',
        `mcp__${SERVER_NAME}`,
        '--tools',
        '',
        '--permission-mode',
        'dontAsk',
        '--setting-sources',
        'user',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--output-format',
        'json',
        '--',
        turn.prompt,
      ],
      env: { [TOKEN_ENV]: turn.token },
      cwd,
    };
  },
};
