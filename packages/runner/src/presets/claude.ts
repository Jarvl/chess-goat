import path from 'node:path';
import {
  claudeMcpConfig,
  detectOnPath,
  SERVER_NAME,
  TOKEN_ENV,
  writeTurnFiles,
  type HarnessPreset,
} from './common.js';

// Flags checked against `claude --help` of 2.1.322:
// - `-p` prints and exits; the prompt is read from STDIN (a multi-line argument is truncated by
//   cmd.exe for .cmd shims on Windows, and long ones hit command-line limits).
// - `--system-prompt-file <file>` replaces the whole system prompt. It is NOT in the options list, but
//   it is real in 2.1.322: `claude --system-prompt-file --help` fails with "System prompt file not
//   found: --help", and the `--bare` help mentions `--system-prompt[-file]`. Undocumented, so to be
//   confirmed by the real run; the fallback is `--system-prompt=<persona>`.
// - `--mcp-config` + `--strict-mcp-config`: only our server. `--allowedTools mcp__chess-goat` allows
//   every tool of that server; `--tools ""` turns every built-in off; `--permission-mode dontAsk`
//   denies whatever is not allowed instead of asking.
// - `--setting-sources user,project` keeps the owner's login and lets the bot folder's own CLAUDE.md
//   and .claude/ load; local settings are skipped. `--bare` would break subscription login.
//   RESIDUAL RISK: user-level and bot-folder hooks and plugins run inside the session and inherit
//   GOAT_TURN_TOKEN. They are the owner's own configuration.
// - Hardening candidates for the real run to evaluate (not used: version-gated, would break older
//   CLIs): `--permission-prompts none` and `--restricted`.
// - `--disable-slash-commands` drops skills and commands.
// - The MCP config references `${GOAT_TURN_TOKEN}`: Claude Code expands env vars in MCP config. To
//   be confirmed by the real run (not possible from --help).
export const claude: HarnessPreset = {
  name: 'claude',
  status: 'unverified',
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
        '--system-prompt-file',
        files.personaFile,
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
        'user,project',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--output-format',
        'json',
      ],
      env: { [TOKEN_ENV]: turn.token },
      cwd,
      stdin: turn.prompt,
    };
  },
};
